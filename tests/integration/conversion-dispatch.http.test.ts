import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/http/app.js";
import { createConversionDispatcher } from "../../src/infra/database/conversion-dispatcher.js";
import { orderSupportRepository } from "../../src/infra/database/order-support.js";
import { orderWebhookRepository } from "../../src/infra/database/order-webhook-repository.js";
import { createOrderWorker } from "../../src/infra/database/order-worker.js";
import { trackingSessionRepository } from "../../src/infra/database/tracking-session-repository.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl || new URL(databaseUrl).pathname.slice(1) !== "tracking_hub_test") throw new Error("Isolated test database required");
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let clock = new Date("2026-11-07T20:00:00.000Z");
const deps = { checkDatabase: async () => {}, getDatabaseDiagnostic: async () => ({ status: "up" as const, trackingSessions: 0 }), trackingSessions: trackingSessionRepository(prisma), orderWebhooks: orderWebhookRepository(prisma), getOrderTracking: orderSupportRepository(prisma), now: () => clock };
const enabledApp = createApp({ ...deps, testScenariosEnabled: true });
const disabledApp = createApp(deps);
const orderWorker = createOrderWorker(prisma, { attributionWindowMinutes: 30, trackingWaitMs: 10000, maxProcessingRetries: 3 }, () => clock);
const dispatch = () => createConversionDispatcher(prisma, { transportTimeoutMs: 2000, deliveryLeaseMs: 10000, deliveryMaxAttempts: 3 }, () => clock);
const sale = { eventId: "conversion-event", event: "ORDER_PAID", orderId: "conversion-order", amount: 25500, currency: "USD", occurredAt: "2026-11-07T19:30:00.000Z", sessionId: "conversion-session" };
const session = { sessionId: "conversion-session", capturedAt: "2026-11-07T19:00:00.000Z", pageUrl: "https://example.test/checkout", customFields: { source: "facebook", campaign: "launch", content: "card", affiliateCode: "AFF-1" }, identifiers: { fbc: "fb.1.123.click", fbp: "fb.1.123.browser", gclid: "google-click", gbraid: "gbraid-click", wbraid: "wbraid-click", ttclid: "tiktok-click", ttp: "tiktok-cookie", redtrackClickId: "redtrack-click", utmifyId: "utmify-click" }, customer: { email: "Buyer@Example.Test", phone: "+1 555 0100" } };

async function setup(scenario?: string, capture = true) {
  if (capture) expect((await request(enabledApp).post("/tracking/sessions").send(session)).status).toBe(201);
  const req = request(enabledApp).post("/webhooks/orders");
  if (scenario) req.set("X-Test-Conversion-Scenario", scenario);
  expect((await req.send(capture ? sale : { ...sale, sessionId: undefined })).status).toBe(202);
  expect(await orderWorker.runOnce()).toBe(true);
}
async function drain(max = 20) {
  for (let i = 0; i < max; i++) if (!(await dispatch().runOnce())) break;
}
async function deliveries() { return prisma.conversionDelivery.findMany({ include: { attempts: { orderBy: { attemptNumber: "asc" } } } }); }

describe("simulated conversion dispatch", () => {
  beforeEach(async () => {
    clock = new Date("2026-11-07T20:00:00.000Z");
    await prisma.conversionAttempt.deleteMany();
    await prisma.conversionDelivery.deleteMany();
    await prisma.webhookEvent.deleteMany();
    await prisma.order.deleteMany();
    await prisma.trackingSession.deleteMany();
  });
  afterAll(async () => {
    await prisma.conversionAttempt.deleteMany();
    await prisma.conversionDelivery.deleteMany();
    await prisma.webhookEvent.deleteMany();
    await prisma.order.deleteMany();
    await prisma.trackingSession.deleteMany();
    await prisma.$disconnect();
  });

  it("sends five distinct payloads and keeps only customer hashes in support", async () => {
    await setup(); await drain();
    const rows = await deliveries();
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.status === "DELIVERED" && row.attempts.length === 1)).toBe(true);
    const byProvider = Object.fromEntries(rows.map((row) => [row.provider, row]));
    const meta = byProvider.META!.frozenRequest as { body: { data: Array<{ event_id: string; custom_data: { value: number }; user_data: { em: string[]; fbc: string } }> } };
    expect(meta.body.data[0]?.custom_data.value).toBe(255);
    expect(meta.body.data[0]?.event_id).toBe(byProvider.META!.conversionId);
    expect(meta.body.data[0]?.user_data.fbc).toBe("fb.1.123.click");
    expect(meta.body.data[0]?.user_data.em[0]).toMatch(/^[a-f0-9]{64}$/);
    expect((byProvider.GOOGLE!.frozenRequest as { body: { conversions: Array<{ gclid: string; gbraid: string; wbraid: string }> } }).body.conversions[0]).toMatchObject({ gclid: "google-click", gbraid: "gbraid-click", wbraid: "wbraid-click" });
    expect((byProvider.TIKTOK!.frozenRequest as { body: { data: Array<{ user: { ttclid: string } }> } }).body.data[0]?.user.ttclid).toBe("tiktok-click");
    expect((byProvider.UTMIFY!.frozenRequest as { body: { amountInCents: number; trackingParameters: Record<string, string>; metadata: Record<string, string> } }).body).toMatchObject({ amountInCents: 25500, trackingParameters: { utm_source: "facebook", utm_campaign: "launch", utm_content: "card" }, metadata: { utmifyId: "utmify-click", affiliateCode: "AFF-1" } });
    expect((byProvider.REDTRACK!.frozenRequest as { query: Record<string, string> }).query).toEqual({ clickid: "redtrack-click" });
    const support = await request(enabledApp).get("/support/orders/conversion-order/tracking");
    expect(support.body.deliveries.find((row: { provider: string }) => row.provider === "META").attempts[0].request.body.data[0].user_data.em).toEqual(meta.body.data[0]?.user_data.em);
    expect(JSON.stringify(support.body)).not.toContain("Buyer@Example.Test");
  });

  it("isolates a Meta retry and preserves its frozen request and digest", async () => {
    await setup("META_RETRY_ONCE"); await drain();
    let rows = await deliveries();
    expect(rows.filter((row) => row.status === "DELIVERED")).toHaveLength(4);
    let meta = rows.find((row) => row.provider === "META")!;
    expect(meta.status).toBe("RETRY_PENDING");
    expect(meta.attempts[0]?.httpStatus).toBe(503);
    const frozen = meta.frozenRequest;
    const digest = meta.requestDigest;
    clock = new Date(clock.getTime() + 1000);
    await dispatch().runOnce();
    rows = await deliveries(); meta = rows.find((row) => row.provider === "META")!;
    expect(meta.status).toBe("DELIVERED");
    expect(meta.attempts.map((attempt) => attempt.status)).toEqual(["FAILED_RETRYABLE", "SUCCEEDED"]);
    expect(meta.attempts.map((attempt) => attempt.requestDigest)).toEqual([digest, digest]);
    expect(meta.frozenRequest).toEqual(frozen);
    expect((await request(enabledApp).post("/webhooks/orders").send({ ...sale, eventId: "second-event" })).status).toBe(202);
    await orderWorker.runOnce(); await dispatch().runOnce();
    expect((await deliveries()).find((row) => row.provider === "META")!.attempts).toHaveLength(2);
  });

  it("honors Retry-After, exhausts known failures, and terminates permanent and application errors", async () => {
    await setup("GOOGLE_RATE_LIMIT_ONCE"); await drain();
    let google = (await deliveries()).find((row) => row.provider === "GOOGLE")!;
    expect(google.status).toBe("RETRY_PENDING");
    expect(google.nextAttemptAt?.getTime()).toBe(clock.getTime() + 1000);
    clock = new Date(clock.getTime() + 1000); await dispatch().runOnce();
    expect((await deliveries()).find((row) => row.provider === "GOOGLE")!.status).toBe("DELIVERED");
    await prisma.conversionAttempt.deleteMany(); await prisma.conversionDelivery.deleteMany(); await prisma.webhookEvent.deleteMany(); await prisma.order.deleteMany(); await prisma.trackingSession.deleteMany();
    await setup("META_ALWAYS_503"); await drain();
    for (const delay of [1000, 3000]) { clock = new Date(clock.getTime() + delay); await dispatch().runOnce(); }
    const meta = (await deliveries()).find((row) => row.provider === "META")!;
    expect(meta.status).toBe("FAILED_EXHAUSTED"); expect(meta.attempts).toHaveLength(3);
  });

  it.each([["TIKTOK_PERMANENT", "TIKTOK", 400, "FAILED_PERMANENT"], ["GOOGLE_APPLICATION_ERROR", "GOOGLE", 200, "FAILED_PERMANENT"], ["META_TIMEOUT", "META", null, "UNKNOWN"]] as const)("classifies %s", async (scenario, provider, httpStatus, status) => {
    await setup(scenario); await drain();
    const row = (await deliveries()).find((item) => item.provider === provider)!;
    expect(row.status).toBe(status); expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]?.httpStatus).toBe(httpStatus);
    clock = new Date(clock.getTime() + 10000); await drain();
    expect((await deliveries()).find((item) => item.provider === provider)!.attempts).toHaveLength(1);
  });

  it("skips insufficient matching signals without fabricating attempts", async () => {
    await setup(undefined, false); await drain();
    const rows = await deliveries();
    expect(rows.find((row) => row.provider === "UTMIFY")!.status).toBe("DELIVERED");
    expect(rows.filter((row) => row.status === "SKIPPED")).toHaveLength(4);
    expect(rows.filter((row) => row.status === "SKIPPED").every((row) => row.reason && row.attempts.length === 0)).toBe(true);
  });

  it("claims once under concurrency and marks expired ownership uncertain", async () => {
    await setup();
    await Promise.all([dispatch().runOnce(), dispatch().runOnce()]);
    const rows = await deliveries();
    expect(rows.flatMap((row) => row.attempts)).toHaveLength(1);
    const pending = rows.find((row) => row.status === "PENDING")!;
    await prisma.conversionDelivery.update({ where: { id: pending.id }, data: { status: "PROCESSING", claimToken: "00000000-0000-4000-8000-000000000001", leaseUntil: clock, nextAttemptAt: null } });
    await prisma.conversionAttempt.create({ data: { deliveryId: pending.id, attemptNumber: 1, startedAt: clock, request: {}, requestDigest: "0".repeat(64) } });
    await dispatch().runOnce();
    const recovered = await prisma.conversionDelivery.findUniqueOrThrow({ where: { id: pending.id }, include: { attempts: true } });
    expect(recovered.status).toBe("UNKNOWN"); expect(recovered.attempts[0]?.errorCode).toBe("LEASE_EXPIRED");
  });

  it("keeps an interrupted post-transport attempt STARTED until lease recovery", async () => {
    await setup();
    const interrupted = createConversionDispatcher(prisma, { transportTimeoutMs: 2000, deliveryLeaseMs: 10000, deliveryMaxAttempts: 3 }, () => clock, { afterTransport: async () => { throw new Error("process stopped"); } });
    await expect(interrupted.runOnce()).rejects.toThrow("process stopped");
    expect(await prisma.conversionAttempt.count({ where: { status: "STARTED" } })).toBe(1);
    clock = new Date(clock.getTime() + 10000);
    await dispatch().runOnce();
    expect(await prisma.conversionAttempt.count({ where: { status: "UNKNOWN" } })).toBe(1);
  });

  it("gates the scenario header and preserves the first event scenario", async () => {
    expect((await request(disabledApp).post("/webhooks/orders").set("X-Test-Conversion-Scenario", "SUCCESS").send(sale)).body.code).toBe("TEST_SCENARIO_DISABLED");
    expect((await request(enabledApp).post("/webhooks/orders").set("X-Test-Conversion-Scenario", "BOGUS").send(sale)).body.code).toBe("INVALID_TEST_SCENARIO");
    await setup("META_RETRY_ONCE");
    const conflict = await request(enabledApp).post("/webhooks/orders").set("X-Test-Conversion-Scenario", "SUCCESS").send(sale);
    expect(conflict.status).toBe(409);
    expect((await request(enabledApp).post("/webhooks/orders").send(sale)).body.duplicate).toBe(true);
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: sale.eventId } })).scenario).toBe("META_RETRY_ONCE");
  });
});
