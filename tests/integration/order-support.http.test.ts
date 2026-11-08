import { Prisma, PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/http/app.js";
import { createConversionDispatcher } from "../../src/infra/database/conversion-dispatcher.js";
import { orderSupportRepository } from "../../src/infra/database/order-support.js";
import { orderWebhookRepository } from "../../src/infra/database/order-webhook-repository.js";
import { createOrderWorker } from "../../src/infra/database/order-worker.js";
import { trackingSessionRepository } from "../../src/infra/database/tracking-session-repository.js";

const url = process.env.DATABASE_URL_TEST;
if (!url || new URL(url).pathname.slice(1) !== "tracking_hub_test") throw new Error("Isolated PostgreSQL database required");
const prisma = new PrismaClient({ datasources: { db: { url } } });
let clock = new Date("2026-11-07T20:00:00.000Z");
const deps = {
  checkDatabase: async () => {},
  getDatabaseDiagnostic: async () => ({ status: "up" as const, trackingSessions: 0 }),
  trackingSessions: trackingSessionRepository(prisma),
  orderWebhooks: orderWebhookRepository(prisma),
  now: () => clock
};
const app = createApp({ ...deps, getOrderTracking: orderSupportRepository(prisma), testScenariosEnabled: true });
const worker = createOrderWorker(prisma, { attributionWindowMinutes: 30, trackingWaitMs: 10000, maxProcessingRetries: 3 }, () => clock);
const dispatcher = createConversionDispatcher(prisma, { transportTimeoutMs: 2000, deliveryLeaseMs: 10000, deliveryMaxAttempts: 3 }, () => clock);
const session = {
  sessionId: "support-session", capturedAt: "2026-11-07T19:00:00.000Z",
  pageUrl: "https://example.test/checkout?email=buyer@example.test&campaign=launch",
  identifiers: { fbc: "fb.1.123.click", gclid: "google-click", ttclid: "tiktok-click", redtrackClickId: "redtrack-click" },
  customFields: { source: "facebook", campaign: "launch", affiliateCode: "AFF-S" },
  customer: { email: "buyer@example.test", phone: "+15550100123" }
};
const sale = { eventId: "support-event", event: "ORDER_PAID", orderId: "support-order", amount: 25500, currency: "USD", occurredAt: "2026-11-07T19:30:00.000Z", sessionId: "support-session" };

async function capture() {
  expect((await request(app).post("/tracking/sessions").send(session)).status).toBe(201);
}
async function receive(body: Record<string, unknown> = sale, scenario?: string) {
  const call = request(app).post("/webhooks/orders");
  if (scenario) call.set("X-Test-Conversion-Scenario", scenario);
  expect((await call.send(body)).status).toBe(202);
}
async function createOrder(body: Record<string, unknown> = sale, scenario?: string) {
  await capture(); await receive(body, scenario); expect(await worker.runOnce()).toBe(true);
}
const get = (orderId = "support-order") => request(app).get(`/support/orders/${orderId}/tracking`);

describe("support order diagnosis", () => {
  beforeEach(async () => {
    clock = new Date("2026-11-07T20:00:00.000Z");
    await prisma.conversionAttempt.deleteMany(); await prisma.conversionDelivery.deleteMany();
    await prisma.webhookEvent.deleteMany(); await prisma.order.deleteMany(); await prisma.trackingSession.deleteMany();
  });
  afterAll(async () => {
    await prisma.conversionAttempt.deleteMany(); await prisma.conversionDelivery.deleteMany();
    await prisma.webhookEvent.deleteMany(); await prisma.order.deleteMany(); await prisma.trackingSession.deleteMany();
    await prisma.$disconnect();
  });

  it("returns no-store on 404, 202 and 200, and keeps database failure distinct", async () => {
    const absent = await get();
    expect(absent.status).toBe(404); expect(absent.body).toEqual({ code: "ORDER_NOT_FOUND" });
    expect(absent.headers["cache-control"]).toBe("no-store");
    await receive({ ...sale, sessionId: "missing-session" });
    await worker.runOnce();
    const waiting = await get();
    expect(waiting.status).toBe(202); expect(waiting.headers["cache-control"]).toBe("no-store");
    expect(waiting.body.processingStatus).toBe("WAITING_TRACKING");
    expect(waiting.body.webhookEvents[0]).toMatchObject({ reason: "TRACKING_PENDING", retryCount: 0 });
    expect(waiting.body.webhookEvents[0].trackingDeadline).toBe("2026-11-07T20:00:10.000Z");
    clock = new Date(clock.getTime() + 10000); await worker.runOnce();
    const complete = await get();
    expect(complete.status).toBe(200); expect(complete.headers["cache-control"]).toBe("no-store");
    expect(complete.body.attribution).toMatchObject({ method: "NONE", sessionId: null, reason: "SESSION_NOT_FOUND" });
    const unreachableUrl = new URL(url!); unreachableUrl.port = "1";
    const unreachable = new PrismaClient({ datasources: { db: { url: unreachableUrl.toString() } } });
    try {
      const broken = createApp({ ...deps, getOrderTracking: orderSupportRepository(unreachable) });
      const response = await request(broken).get("/support/orders/any/tracking");
      expect(response.status).toBe(503); expect(response.body).toEqual({ code: "SUPPORT_LOOKUP_FAILED" });
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally { await unreachable.$disconnect(); }
  });

  it("persists evidence for session fields and webhook campaign without merging a partial group", async () => {
    await createOrder({ ...sale, customFields: { campaign: "webhook-sale" } });
    const result = await get();
    expect(result.body.attribution.customFields).toEqual({ campaign: "webhook-sale" });
    expect(result.body.attribution.identifiers.gclid).toBe("google-click");
    expect(result.body.attribution.evidence["identifiers.gclid"]).toEqual({ source: "TRACKING_SESSION", sourceId: session.sessionId, path: "identifiers.gclid" });
    expect(result.body.attribution.evidence["customFields.campaign"]).toEqual({ source: "WEBHOOK", sourceId: sale.eventId, path: "customFields.campaign" });
    expect(result.body.attribution.evidence["customFields.affiliateCode"]).toBeUndefined();
    const stored = await prisma.order.findUniqueOrThrow({ where: { orderId: sale.orderId } });
    expect((stored.attribution as Record<string, unknown>).evidence).toBeDefined();
  });

  it("uses session customFields when webhook group is empty and preserves the snapshot after conflict", async () => {
    await createOrder();
    const baseline = (await get()).body;
    expect(baseline.attribution.evidence["customFields.affiliateCode"]).toEqual({ source: "TRACKING_SESSION", sourceId: session.sessionId, path: "customFields.affiliateCode" });
    await receive({ ...sale, eventId: "second-event", amount: 999 });
    await worker.runOnce();
    const after = (await get()).body;
    expect(after.attribution).toEqual(baseline.attribution);
    expect(after.deliveries).toEqual(baseline.deliveries);
    expect(after.webhookEvents.find((event: { eventId: string }) => event.eventId === "second-event")).toMatchObject({ status: "CONFLICT", reason: "ORDER_DATA_CONFLICT" });
  });

  it("reports legacy evidence as UNKNOWN without inferring provenance", async () => {
    await createOrder();
    const order = await prisma.order.findUniqueOrThrow({ where: { orderId: sale.orderId } });
    const snapshot = order.attribution as Record<string, unknown>;
    delete snapshot.evidence;
    await prisma.order.update({ where: { id: order.id }, data: { attribution: snapshot as Prisma.InputJsonObject } });
    const result = await get();
    expect(result.body.attribution.provenance["identifiers.gclid"]).toBe("trackingSession.identifiers.gclid");
    expect(result.body.attribution.evidence["identifiers.gclid"]).toEqual({ source: "UNKNOWN", sourceId: null, path: null });
  });

  it("shows STARTED without invented completion, and GET does not change database state", async () => {
    await createOrder();
    const delivery = await prisma.conversionDelivery.findFirstOrThrow({ where: { provider: "META" } });
    await prisma.conversionDelivery.update({ where: { id: delivery.id }, data: { status: "PROCESSING", claimToken: "00000000-0000-4000-8000-000000000001", leaseUntil: new Date(clock.getTime() + 10000) } });
    await prisma.conversionAttempt.create({ data: { deliveryId: delivery.id, attemptNumber: 1, startedAt: clock, status: "STARTED", request: { method: "POST", url: "https://meta.invalid/conversions", headers: {} }, requestDigest: "a".repeat(64) } });
    const before = await Promise.all([prisma.webhookEvent.count(), prisma.order.count(), prisma.conversionDelivery.count(), prisma.conversionAttempt.count(), prisma.order.findUniqueOrThrow({ where: { orderId: sale.orderId } })]);
    const responses = await Promise.all([get(), get(), get()]);
    for (const response of responses) {
      const meta = response.body.deliveries.find((item: { provider: string }) => item.provider === "META");
      expect(meta.status).toBe("PROCESSING");
      expect(meta.attempts[0]).toMatchObject({ status: "STARTED", finishedAt: null, httpStatus: null });
    }
    const after = await Promise.all([prisma.webhookEvent.count(), prisma.order.count(), prisma.conversionDelivery.count(), prisma.conversionAttempt.count(), prisma.order.findUniqueOrThrow({ where: { orderId: sale.orderId } })]);
    expect(after).toEqual(before);
  });

  it("keeps events and deliveries in stable order and shows a later pending webhook with an existing order", async () => {
    await createOrder();
    await receive({ ...sale, eventId: "z-event" });
    await receive({ ...sale, eventId: "a-event" });
    const result = await get();
    expect(result.status).toBe(200);
    expect(result.body.webhookEvents.map((item: { eventId: string }) => item.eventId)).toEqual(["a-event", "support-event", "z-event"]);
    expect(result.body.webhookEvents.find((item: { eventId: string }) => item.eventId === "z-event").status).toBe("PENDING");
    expect(result.body.deliveries.map((item: { provider: string }) => item.provider)).toEqual(["GOOGLE", "META", "REDTRACK", "TIKTOK", "UTMIFY"]);
  });

  it("reads order, attempts and events from one RepeatableRead snapshot", async () => {
    await createOrder();
    await receive({ ...sale, eventId: "committed-during-read" });
    let reached!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const repo = orderSupportRepository(prisma, { afterOrderRead: async () => { reached(); await gate; } });
    const reading = repo(sale.orderId);
    await entered;
    await worker.runOnce();
    release();
    const oldView = await reading;
    const oldEvent = (oldView.body as { webhookEvents: Array<{ eventId: string; status: string }> }).webhookEvents.find((event) => event.eventId === "committed-during-read");
    expect(oldEvent?.status).toBe("PENDING");
    expect((await get()).body.webhookEvents.find((event: { eventId: string }) => event.eventId === "committed-during-read").status).toBe("PROCESSED");
  });

  it("protects secrets in request, response, attribution and errors without mutating storage", async () => {
    await createOrder();
    const meta = await prisma.conversionDelivery.findFirstOrThrow({ where: { provider: "META" } });
    const original = {
      method: "POST", url: "https://meta.invalid/conversions?token=shh-secret&email=buyer@example.test&campaign=launch",
      headers: { Authorization: "a".repeat(64), "X-Api-Key": "top-secret" },
      body: { data: [{ user_data: { em: ["b".repeat(64)], ph: ["c".repeat(64)] }, event_source_url: "https://example.test/?phone=%2B15550100123&source=facebook" }] },
      query: { clickid: "tracking-click", token: "query-secret" }
    };
    await prisma.conversionDelivery.update({ where: { id: meta.id }, data: { status: "DELIVERED", frozenRequest: original } });
    await prisma.conversionAttempt.create({ data: { deliveryId: meta.id, attemptNumber: 1, startedAt: clock, finishedAt: clock, status: "SUCCEEDED", httpStatus: 200, request: original, response: { apiKey: "response-secret", message: "buyer@example.test", text: "x".repeat(3000) }, requestDigest: "d".repeat(64) } });
    await prisma.webhookEvent.update({ where: { eventId: sale.eventId }, data: { lastError: "Bearer event-secret" } });
    const storedBefore = await prisma.conversionDelivery.findUniqueOrThrow({ where: { id: meta.id }, include: { attempts: true } });
    const result = await get();
    const exposed = result.body.deliveries.find((item: { provider: string }) => item.provider === "META").attempts[0];
    const text = JSON.stringify(result.body);
    for (const secret of ["shh-secret", "buyer@example.test", "+15550100123", "top-secret", "query-secret", "response-secret", "event-secret"]) expect(text).not.toContain(secret);
    expect(exposed.request.headers.Authorization).toBe("[REDACTED]");
    expect(exposed.request.query.clickid).toBe("tracking-click");
    expect(exposed.request.body.data[0].user_data.em).toEqual(["b".repeat(64)]);
    expect(exposed.response.text).toContain("[TRUNCATED]");
    expect(exposed.requestDigest).toBe("d".repeat(64));
    const storedAfter = await prisma.conversionDelivery.findUniqueOrThrow({ where: { id: meta.id }, include: { attempts: true } });
    expect(storedAfter).toEqual(storedBefore);
  });

  it("loads deliveries and attempts in batches rather than querying each attempt", async () => {
    await createOrder();
    const observed = new PrismaClient({ datasources: { db: { url: url! } }, log: [{ emit: "event", level: "query" }] });
    let queries = 0;
    observed.$on("query", () => { queries += 1; });
    try {
      const lookup = orderSupportRepository(observed);
      await lookup(sale.orderId);
      const before = queries;
      for (let i = 0; i < 5; i++) await dispatcher.runOnce();
      queries = 0;
      await lookup(sale.orderId);
      expect(queries).toBe(before);
      expect(queries).toBeLessThan(10);
    } finally { await observed.$disconnect(); }
  });

  it("shows isolated 503 then 200 with the same request digest and attempt numbers", async () => {
    await createOrder(sale, "META_RETRY_ONCE");
    for (let i = 0; i < 5; i++) await dispatcher.runOnce();
    const waiting = (await get()).body;
    const metaWaiting = waiting.deliveries.find((item: { provider: string }) => item.provider === "META");
    expect(metaWaiting.status).toBe("RETRY_PENDING");
    expect(metaWaiting.attempts[0]).toMatchObject({ attemptNumber: 1, status: "FAILED_RETRYABLE", httpStatus: 503 });
    expect(waiting.deliveries.filter((item: { status: string }) => item.status === "DELIVERED")).toHaveLength(4);
    clock = new Date(clock.getTime() + 1000); await dispatcher.runOnce();
    const done = (await get()).body.deliveries.find((item: { provider: string }) => item.provider === "META");
    expect(done.status).toBe("DELIVERED");
    expect(done.attempts.map((attempt: { attemptNumber: number }) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(done.attempts.map((attempt: { httpStatus: number }) => attempt.httpStatus)).toEqual([503, 200]);
    expect(done.attempts[0].requestDigest).toBe(done.attempts[1].requestDigest);
    expect(done.attempts[0].request).toEqual(done.attempts[1].request);
  });

  it.each([
    ["TIKTOK_PERMANENT", "TIKTOK", "FAILED_PERMANENT", 400],
    ["GOOGLE_APPLICATION_ERROR", "GOOGLE", "FAILED_PERMANENT", 200],
    ["META_TIMEOUT", "META", "UNKNOWN", null]
  ] as const)("diagnoses %s without labelling the other providers as failed", async (scenario, provider, status, httpStatus) => {
    await createOrder(sale, scenario);
    for (let i = 0; i < 5; i++) await dispatcher.runOnce();
    const rows = (await get()).body.deliveries;
    const failed = rows.find((item: { provider: string }) => item.provider === provider);
    expect(failed.status).toBe(status);
    expect(failed.attempts[0].httpStatus).toBe(httpStatus);
    expect(rows.filter((item: { provider: string; status: string }) => item.provider !== provider).every((item: { status: string }) => item.status === "DELIVERED")).toBe(true);
    if (status === "UNKNOWN") expect(failed.attempts[0].errorCode).toBe("TRANSPORT_TIMEOUT");
  });

  it("shows all attempts when a temporary failure is exhausted", async () => {
    await createOrder(sale, "META_ALWAYS_503");
    for (let i = 0; i < 5; i++) await dispatcher.runOnce();
    for (const delay of [1000, 3000]) { clock = new Date(clock.getTime() + delay); await dispatcher.runOnce(); }
    const meta = (await get()).body.deliveries.find((item: { provider: string }) => item.provider === "META");
    expect(meta.status).toBe("FAILED_EXHAUSTED");
    expect(meta.attempts.map((attempt: { httpStatus: number }) => attempt.httpStatus)).toEqual([503, 503, 503]);
  });
});
