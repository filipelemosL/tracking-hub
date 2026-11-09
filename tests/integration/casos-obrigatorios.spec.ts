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
if (!databaseUrl || new URL(databaseUrl).pathname.slice(1) !== "tracking_hub_test") {
  throw new Error("Os casos obrigatórios exigem o banco isolado tracking_hub_test");
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let clock = new Date("2026-11-07T20:00:00.000Z");
const app = createApp({
  checkDatabase: async () => {},
  getDatabaseDiagnostic: async () => ({ status: "up", trackingSessions: 0 }),
  trackingSessions: trackingSessionRepository(prisma),
  orderWebhooks: orderWebhookRepository(prisma),
  getOrderTracking: orderSupportRepository(prisma),
  now: () => clock,
  testScenariosEnabled: true
});
const worker = createOrderWorker(prisma, {
  attributionWindowMinutes: 30, trackingWaitMs: 10_000, maxProcessingRetries: 3
}, () => clock);
const dispatcher = () => createConversionDispatcher(prisma, {
  transportTimeoutMs: 2_000, deliveryLeaseMs: 10_000, deliveryMaxAttempts: 3
}, () => clock);

const sale = {
  eventId: "required-event", event: "ORDER_PAID", orderId: "required-order",
  sessionId: "required-session", amount: 25500, currency: "USD",
  occurredAt: "2026-11-07T19:30:00.000Z",
  customer: { email: "customer@example.test" }
};

async function clearDatabase() {
  await prisma.conversionAttempt.deleteMany();
  await prisma.conversionDelivery.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.order.deleteMany();
  await prisma.trackingSession.deleteMany();
}

async function capture(sessionId = sale.sessionId, capturedAt = "2026-11-07T19:00:00.000Z") {
  const response = await request(app).post("/tracking/sessions").send({
    sessionId, capturedAt, pageUrl: "https://checkout.example.test/product",
    customFields: { source: "google", campaign: "launch", affiliateCode: "AFF-001" },
    identifiers: { gclid: "pixel-google-click", fbclid: "pixel-meta-click", redtrackClickId: "pixel-redtrack-click" },
    customer: { email: sale.customer.email }
  });
  expect(response.status).toBe(201);
}

async function webhook(body: Record<string, unknown> = sale, scenario?: string) {
  const post = request(app).post("/webhooks/orders");
  if (scenario) post.set("X-Test-Conversion-Scenario", scenario);
  return post.send(body);
}

async function support() {
  const response = await request(app).get(`/support/orders/${sale.orderId}/tracking`);
  expect(response.status).toBe(200);
  return response.body;
}

async function dispatchAll() {
  for (let index = 0; index < 10; index++) if (!(await dispatcher().runOnce())) break;
}

describe("casos obrigatórios do enunciado", () => {
  beforeEach(async () => {
    clock = new Date("2026-11-07T20:00:00.000Z");
    await clearDatabase();
  });
  afterAll(async () => {
    await clearDatabase();
    await prisma.$disconnect();
  });

  it("1. relaciona a venda por sessionId válido", async () => {
    await capture();
    expect((await webhook()).status).toBe(202);
    expect(await prisma.order.count()).toBe(0);
    await worker.runOnce();
    expect((await support()).attribution).toMatchObject({
      status: "ATTRIBUTED", method: "SESSION_ID", sessionId: sale.sessionId
    });
  });

  it("2. registra venda sem tracking como não atribuída", async () => {
    expect((await webhook({ ...sale, sessionId: undefined, customer: undefined })).status).toBe(202);
    await worker.runOnce();
    const result = await support();
    expect(result.order).toMatchObject({ orderId: sale.orderId, amount: 25500 });
    expect(result.attribution).toMatchObject({ status: "UNATTRIBUTED", reason: "NO_MATCH", customFields: {} });
  });

  it("3. repete o mesmo eventId sem duplicar pedido ou conversão", async () => {
    await capture();
    expect((await webhook()).body.duplicate).toBe(false);
    await worker.runOnce();
    await dispatchAll();
    const before = await prisma.conversionDelivery.findMany({ select: { conversionId: true } });
    expect((await webhook()).body.duplicate).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.conversionDelivery.findMany({ select: { conversionId: true } })).map((row) => row.conversionId).sort())
      .toEqual(before.map((row) => row.conversionId).sort());
  });

  it("4. recupera customFields da sessão quando o webhook não os fornece", async () => {
    await capture();
    await webhook();
    await worker.runOnce();
    const attribution = (await support()).attribution;
    expect(attribution.customFields).toMatchObject({ campaign: "launch", affiliateCode: "AFF-001" });
    expect(attribution.provenance["customFields.campaign"]).toBe("trackingSession.customFields.campaign");
  });

  it("5. tenta novamente uma falha temporária sem bloquear os outros provedores", async () => {
    await capture();
    await webhook(sale, "META_RETRY_ONCE");
    await worker.runOnce();
    await dispatchAll();
    let rows = await prisma.conversionDelivery.findMany({ include: { attempts: true } });
    expect(rows.filter((row) => row.status === "DELIVERED")).toHaveLength(4);
    expect(rows.find((row) => row.provider === "META")).toMatchObject({
      status: "RETRY_PENDING", attempts: [{ attemptNumber: 1, status: "FAILED_RETRYABLE", httpStatus: 503 }]
    });
    clock = new Date(clock.getTime() + 1_000);
    await dispatcher().runOnce();
    rows = await prisma.conversionDelivery.findMany({ include: { attempts: { orderBy: { attemptNumber: "asc" } } } });
    expect(rows.find((row) => row.provider === "META")).toMatchObject({
      status: "DELIVERED", attempts: [{ attemptNumber: 1, status: "FAILED_RETRYABLE" }, { attemptNumber: 2, status: "SUCCEEDED" }]
    });
  });

  it("6. reprocessa a venda sem reenviar conversões já entregues", async () => {
    await capture();
    await webhook();
    await worker.runOnce();
    await dispatchAll();
    const before = await prisma.conversionDelivery.findMany({ include: { attempts: true } });
    expect(before.filter((row) => row.status === "DELIVERED")).toHaveLength(5);
    await prisma.webhookEvent.update({ where: { eventId: sale.eventId }, data: { status: "PENDING" } });
    await worker.runOnce();
    await dispatchAll();
    const after = await prisma.conversionDelivery.findMany({ include: { attempts: true } });
    expect(after.map((row) => [row.conversionId, row.attempts.length]).sort()).toEqual(
      before.map((row) => [row.conversionId, row.attempts.length]).sort()
    );
  });

  it("7. usa o click ID capturado no pixel quando o webhook não o traz", async () => {
    await capture();
    await webhook();
    await worker.runOnce();
    await dispatchAll();
    const result = await support();
    expect(result.attribution.identifiers.gclid).toBe("pixel-google-click");
    expect(result.attribution.provenance["identifiers.gclid"]).toBe("trackingSession.identifiers.gclid");
    const google = await prisma.conversionDelivery.findFirstOrThrow({ where: { provider: "GOOGLE" } });
    expect(google.frozenRequest).toMatchObject({ body: { conversions: [{ gclid: "pixel-google-click" }] } });
  });

  it("8. não escolhe arbitrariamente entre duas sessões do mesmo cliente", async () => {
    await capture("required-session-1", "2026-11-07T19:10:00.000Z");
    await capture("required-session-2", "2026-11-07T19:20:00.000Z");
    await webhook({ ...sale, sessionId: undefined });
    await worker.runOnce();
    expect((await support()).attribution).toMatchObject({
      status: "UNATTRIBUTED", method: "NONE", reason: "AMBIGUOUS_CUSTOMER_MATCH", sessionId: null
    });
  });
});
