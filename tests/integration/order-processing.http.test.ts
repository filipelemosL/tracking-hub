import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/http/app.js";
import { orderWebhookRepository } from "../../src/infra/database/order-webhook-repository.js";
import { orderSupportRepository } from "../../src/infra/database/order-support.js";
import { createOrderWorker } from "../../src/infra/database/order-worker.js";
import { trackingSessionRepository } from "../../src/infra/database/tracking-session-repository.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl || new URL(databaseUrl).pathname.slice(1) !== "tracking_hub_test") {
  throw new Error("Order integration tests require tracking_hub_test");
}
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let clock = new Date("2026-11-07T20:00:00.000Z");
const app = createApp({
  checkDatabase: async () => {}, getDatabaseDiagnostic: async () => ({ status: "up", trackingSessions: 0 }),
  trackingSessions: trackingSessionRepository(prisma), orderWebhooks: orderWebhookRepository(prisma),
  getOrderTracking: orderSupportRepository(prisma), now: () => clock
});
const worker = createOrderWorker(prisma, {
  attributionWindowMinutes: 30, trackingWaitMs: 10_000, maxProcessingRetries: 3
}, () => clock);
const payload = {
  eventId: "evt_1", event: "ORDER_PAID", orderId: "ORD-1", amount: 25500,
  currency: "USD", occurredAt: "2026-11-07T19:30:00.000Z",
  sessionId: "session_1", customer: { email: "buyer@example.test" }
};

async function capture(sessionId = "session_1", capturedAt = "2026-11-07T19:00:00.000Z", affiliateCode = "AFF-001") {
  const result = await request(app).post("/tracking/sessions").send({
    sessionId, capturedAt, pageUrl: "https://checkout.example.test/product",
    customFields: { source: "facebook", affiliateCode },
    identifiers: { fbclid: "pixel-click-id" }, customer: { email: "buyer@example.test" }
  });
  expect(result.status).toBe(201);
}
async function send(body: Record<string, unknown> = payload) {
  return request(app).post("/webhooks/orders").send(body);
}
async function support(orderId = "ORD-1") {
  return request(app).get(`/support/orders/${orderId}/tracking`);
}
async function drain(max = 6) {
  for (let index = 0; index < max; index++) if (!(await worker.runOnce())) break;
}

describe("durable order processing", () => {
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

  it("commits the original webhook before 202 and completes it after the worker resumes", async () => {
    await capture();
    const accepted = await send();
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ eventId: "evt_1", accepted: true, duplicate: false });
    const pending = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_1" } });
    expect(pending.status).toBe("PENDING");
    expect(pending.originalPayload).toEqual(payload);
    expect(await prisma.order.count()).toBe(0);
    expect((await support()).status).toBe(202);
    await worker.runOnce();
    const result = await support();
    expect(result.status).toBe(200);
    expect(result.body.order).toMatchObject({ orderId: "ORD-1", amount: 25500, currency: "USD", timeSource: "OCCURRED_AT" });
    expect(result.body.attribution).toMatchObject({ status: "ATTRIBUTED", method: "SESSION_ID", reason: "SESSION_ID_MATCH",
      sessionId: "session_1", identifiers: { fbclid: "pixel-click-id" }, customFields: { affiliateCode: "AFF-001" } });
    expect(result.body.attribution.provenance["identifiers.fbclid"]).toBe("trackingSession.identifiers.fbclid");
    expect(result.body.deliveries).toHaveLength(5);
    expect(result.body.deliveries.every((item: { status: string; attempts: unknown[] }) => item.status === "PENDING" && item.attempts.length === 0)).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain("buyer@example.test");
  });

  it("uses webhook campaign as one group and records a different affiliate from the session", async () => {
    await capture();
    await send({ ...payload, customFields: { campaign: "sale", affiliateCode: "AFF-OTHER" } });
    await worker.runOnce();
    const result = (await support()).body.attribution;
    expect(result.customFields).toEqual({ campaign: "sale", affiliateCode: "AFF-OTHER" });
    expect(result.provenance["customFields.affiliateCode"]).toBe("webhook.customFields.affiliateCode");
    expect(result.identifiers.fbclid).toBe("pixel-click-id");
    expect(result.customFieldConflicts).toContainEqual({ field: "affiliateCode", webhookValue: "AFF-OTHER", sessionValue: "AFF-001" });
  });

  it("does not fill a partial webhook campaign with the session affiliate", async () => {
    await capture();
    await send({ ...payload, customFields: { campaign: "sale" } });
    await worker.runOnce();
    const result = (await support()).body.attribution;
    expect(result.customFields).toEqual({ campaign: "sale" });
    expect(result.provenance["customFields.campaign"]).toBe("webhook.customFields.campaign");
  });

  it("records a sale without tracking and no invented campaign", async () => {
    await send({ ...payload, sessionId: undefined, customer: undefined });
    await worker.runOnce();
    const result = await support();
    expect(result.body.attribution).toMatchObject({ status: "UNATTRIBUTED", method: "NONE", reason: "NO_MATCH",
      sessionId: null, customFields: {}, identifiers: {} });
    expect(result.body.deliveries).toHaveLength(5);
  });

  it("deduplicates the same event in parallel without replacing original payload or time", async () => {
    const responses = await Promise.all([send({ ...payload }), send({ ...payload })]);
    expect(responses.map((item) => item.body.duplicate).sort()).toEqual([false, true]);
    const original = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_1" } });
    expect(await prisma.webhookEvent.count()).toBe(1);
    await worker.runOnce();
    expect(await prisma.order.count()).toBe(0);
    clock = new Date(clock.getTime() + 1_000);
    const repeat = await send({ ...payload });
    expect(repeat.status).toBe(202);
    expect(repeat.body.duplicate).toBe(true);
    const reloaded = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_1" } });
    expect(reloaded.id).toBe(original.id);
    expect(reloaded.originalPayload).toEqual(original.originalPayload);
    expect(reloaded.receivedAt).toEqual(original.receivedAt);
  });

  it("rejects a changed eventId payload without altering the durable original", async () => {
    await send(payload);
    const response = await send({ ...payload, amount: 25501 });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("WEBHOOK_EVENT_CONFLICT");
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_1" } })).originalPayload).toEqual(payload);
  });

  it("creates one order and five stable deliveries for different events of the same order", async () => {
    await capture();
    const responses = await Promise.all([send(payload), send({ ...payload, eventId: "evt_2" })]);
    expect(responses.every((item) => item.status === 202)).toBe(true);
    await Promise.all([worker.runOnce(), worker.runOnce()]);
    await drain();
    expect(await prisma.order.count()).toBe(1);
    const deliveries = await prisma.conversionDelivery.findMany();
    expect(deliveries).toHaveLength(5);
    expect(new Set(deliveries.map((item) => item.conversionId)).size).toBe(5);
    expect((await prisma.webhookEvent.findMany()).map((item) => item.status)).toEqual(["PROCESSED", "PROCESSED"]);
    const before = deliveries.map((item) => item.conversionId).sort();
    await send({ ...payload, eventId: "evt_3" });
    await worker.runOnce();
    expect((await prisma.conversionDelivery.findMany()).map((item) => item.conversionId).sort()).toEqual(before);
  });

  it("marks an incompatible later event without changing the completed order or conversion IDs", async () => {
    await capture();
    await send(payload);
    await worker.runOnce();
    const order = await prisma.order.findUniqueOrThrow({ where: { orderId: "ORD-1" } });
    const ids = (await prisma.conversionDelivery.findMany()).map((item) => item.conversionId).sort();
    await send({ ...payload, eventId: "evt_2", amount: 999 });
    await worker.runOnce();
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_2" } })).reason).toBe("ORDER_DATA_CONFLICT");
    await capture("session_2");
    await send({ ...payload, eventId: "evt_3", sessionId: "session_2" });
    await worker.runOnce();
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_3" } })).status).toBe("CONFLICT");
    expect(await prisma.order.findUniqueOrThrow({ where: { orderId: "ORD-1" } })).toEqual(order);
    expect((await prisma.conversionDelivery.findMany()).map((item) => item.conversionId).sort()).toEqual(ids);
  });

  it("preserves a completed snapshot and delivery IDs when the event is reprocessed", async () => {
    await capture();
    await send(payload);
    await worker.runOnce();
    const original = await prisma.order.findUniqueOrThrow({ where: { orderId: "ORD-1" } });
    const ids = (await prisma.conversionDelivery.findMany()).map((item) => item.conversionId).sort();
    await prisma.webhookEvent.update({ where: { eventId: "evt_1" }, data: { status: "PENDING" } });
    await worker.runOnce();
    expect(await prisma.order.findUniqueOrThrow({ where: { orderId: "ORD-1" } })).toEqual(original);
    expect((await prisma.conversionDelivery.findMany()).map((item) => item.conversionId).sort()).toEqual(ids);
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_1" } })).status).toBe("PROCESSED");
  });

  it("does not revise a completed unattributed sale when tracking appears later", async () => {
    await send({ ...payload, sessionId: undefined, customer: undefined });
    await worker.runOnce();
    const original = await prisma.order.findUniqueOrThrow({ where: { orderId: "ORD-1" } });
    await capture();
    expect(await prisma.order.findUniqueOrThrow({ where: { orderId: "ORD-1" } })).toEqual(original);
  });

  it("rolls back an interrupted transaction and completes on the next eligible retry", async () => {
    await capture();
    await send(payload);
    let fail = true;
    const interrupted = createOrderWorker(prisma, { attributionWindowMinutes: 30, trackingWaitMs: 10_000,
      maxProcessingRetries: 3 }, () => clock, { afterOrderCreated: async () => {
        if (fail) { fail = false; throw new Error("simulated failure"); }
      } });
    await interrupted.runOnce();
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.conversionDelivery.count()).toBe(0);
    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_1" } });
    expect(event).toMatchObject({ status: "PENDING", retryCount: 1, reason: "PROCESSING_ERROR" });
    clock = new Date(clock.getTime() + 1_000);
    await interrupted.runOnce();
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.conversionDelivery.count()).toBe(5);
  });

  it("stops processing retries after three failures and exposes a protected terminal error", async () => {
    await capture();
    await send(payload);
    const failing = createOrderWorker(prisma, { attributionWindowMinutes: 30, trackingWaitMs: 10_000,
      maxProcessingRetries: 3 }, () => clock, { afterOrderCreated: async () => { throw new Error("private customer detail"); } });
    for (const advance of [0, 1000, 2000]) {
      clock = new Date(clock.getTime() + advance);
      await failing.runOnce();
    }
    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_1" } });
    expect(event).toMatchObject({ status: "FAILED", reason: "PROCESSING_ERROR", retryCount: 3 });
    expect(await prisma.order.count()).toBe(0);
    const diagnostic = await support();
    expect(diagnostic.status).toBe(200);
    expect(diagnostic.body.processingStatus).toBe("FAILED");
    expect(JSON.stringify(diagnostic.body)).not.toContain("private customer detail");
  });

  it("leaves two eligible customer sessions ambiguous", async () => {
    await capture("session_1", "2026-11-07T19:10:00.000Z");
    await capture("session_2", "2026-11-07T19:20:00.000Z");
    await send({ ...payload, sessionId: undefined });
    await worker.runOnce();
    expect((await support()).body.attribution).toMatchObject({ status: "UNATTRIBUTED", method: "NONE",
      reason: "AMBIGUOUS_CUSTOMER_MATCH", sessionId: null });
  });

  it("uses occurredAt to exclude a session captured after purchase", async () => {
    await capture("session_1", "2026-11-07T19:45:00.000Z");
    await send(payload);
    await worker.runOnce();
    expect((await support()).body.attribution).toMatchObject({ status: "UNATTRIBUTED", reason: "SESSION_AFTER_ORDER" });
  });

  it("waits for an unknown session and associates it when captured evidence arrives", async () => {
    await send(payload);
    await worker.runOnce();
    const pending = await support();
    expect(pending.status).toBe(202);
    expect(pending.body.processingStatus).toBe("WAITING_TRACKING");
    expect(pending.body.webhookEvents[0].trackingDeadline).toBe("2026-11-07T20:00:10.000Z");
    await capture();
    clock = new Date(clock.getTime() + 1_000);
    await worker.runOnce();
    expect((await support()).body.attribution).toMatchObject({ method: "SESSION_ID", sessionId: "session_1" });
  });

  it("does not let a later event bypass an earlier event waiting for tracking", async () => {
    await send(payload);
    await worker.runOnce();
    await send({ ...payload, eventId: "evt_2", sessionId: undefined, customer: undefined });
    await worker.runOnce();
    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_2" } })).reason).toBe("WAITING_PRIOR_EVENT");
    await capture();
    clock = new Date(clock.getTime() + 1_000);
    await drain();
    expect((await support()).body.attribution).toMatchObject({ method: "SESSION_ID", sessionId: "session_1" });
    expect(await prisma.order.count()).toBe(1);
  });

  it("expires missing tracking and records a final unattributed sale", async () => {
    await send({ ...payload, customer: undefined });
    await worker.runOnce();
    clock = new Date(clock.getTime() + 10_000);
    await worker.runOnce();
    expect((await support()).body.attribution).toMatchObject({ status: "UNATTRIBUTED", reason: "SESSION_NOT_FOUND" });
  });

  it("falls back to a unique customer only after the unknown session wait expires", async () => {
    await capture("session_1");
    await send({ ...payload, sessionId: "missing-session" });
    await worker.runOnce();
    expect((await support()).body.processingStatus).toBe("WAITING_TRACKING");
    clock = new Date(clock.getTime() + 10_000);
    await worker.runOnce();
    expect((await support()).body.attribution).toMatchObject({
      status: "ATTRIBUTED", method: "CUSTOMER", sessionId: "session_1", requestedSessionId: "missing-session"
    });
  });

  it("falls back to one customer session in the preceding window", async () => {
    await capture();
    await send({ ...payload, sessionId: undefined });
    await worker.runOnce();
    expect((await support()).body.attribution).toMatchObject({ status: "ATTRIBUTED", method: "CUSTOMER", sessionId: "session_1" });
  });

  it("uses first receivedAt when occurredAt is absent", async () => {
    await send({ ...payload, occurredAt: undefined, sessionId: undefined, customer: undefined });
    await worker.runOnce();
    expect((await support()).body.order).toMatchObject({ occurredAt: clock.toISOString(), timeSource: "RECEIVED_AT" });
  });

  it("returns 404 for an unknown order and 400 for malformed JSON", async () => {
    expect((await support("missing-order")).status).toBe(404);
    const invalid = await request(app).post("/webhooks/orders").set("Content-Type", "application/json").send("{");
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ code: "VALIDATION_ERROR", fields: ["body"] });
  });

  it.each([
    [{ ...payload, eventId: "" }, "eventId"],
    [{ ...payload, event: "OTHER" }, "event"],
    [{ ...payload, amount: 1.5 }, "amount"],
    [{ ...payload, amount: "100" }, "amount"],
    [{ ...payload, currency: "usd" }, "currency"],
    [{ ...payload, occurredAt: "2026-11-07" }, "occurredAt"],
    [{ ...payload, occurredAt: "2026-11-07T20:05:00.001Z" }, "occurredAt"]
  ])("rejects invalid sale input before persistence", async (body, field) => {
    const response = await send(body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ code: "VALIDATION_ERROR", fields: [field] });
    expect(await prisma.webhookEvent.count()).toBe(0);
  });
});
