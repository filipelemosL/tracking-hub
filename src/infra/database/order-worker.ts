import { createHash } from "node:crypto";

import { Prisma, type PrismaClient, type TrackingSession } from "@prisma/client";

import { buildAttribution, sessionTime, type AttributionReason } from "../../application/orders/attribution.js";
import type { NormalizedOrderWebhook } from "../../application/orders/order-webhook.js";

const providers = ["META", "GOOGLE", "TIKTOK", "UTMIFY", "REDTRACK"] as const;

export type OrderWorkerConfig = {
  attributionWindowMinutes: number;
  trackingWaitMs: number;
  maxProcessingRetries: number;
};

export type WorkerHooks = { afterOrderCreated?: () => Promise<void> };

export function createOrderWorker(
  prisma: PrismaClient,
  config: OrderWorkerConfig,
  now: () => Date = () => new Date(),
  hooks: WorkerHooks = {}
) {
  async function processEvent(eventId: string, cycleTime: Date): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const selected = await tx.webhookEvent.findUniqueOrThrow({ where: { eventId } });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${selected.orderId}, 0))`;
      const event = await tx.webhookEvent.findUniqueOrThrow({ where: { eventId } });
      if (!(["PENDING", "WAITING_TRACKING"] as string[]).includes(event.status) || event.nextAttemptAt > cycleTime) return;
      const input = event.normalizedPayload as NormalizedOrderWebhook;
      const existingOrder = await tx.order.findUnique({
        where: { orderId: input.orderId }, include: { trackingSession: true }
      });
      if (existingOrder) {
        const incompatible = existingOrder.amount !== BigInt(input.amount) ||
          existingOrder.currency !== input.currency ||
          (existingOrder.trackingSession && input.sessionId && existingOrder.trackingSession.sessionId !== input.sessionId);
        await tx.webhookEvent.update({ where: { id: event.id }, data: {
          status: incompatible ? "CONFLICT" : "PROCESSED",
          reason: incompatible ? "ORDER_DATA_CONFLICT" : null,
          orderDbId: existingOrder.id,
          lastError: null
        } });
        return;
      }

      const earlierEvent = await tx.webhookEvent.findFirst({ where: {
        orderId: event.orderId,
        status: { in: ["PENDING", "WAITING_TRACKING"] },
        OR: [
          { receivedAt: { lt: event.receivedAt } },
          { receivedAt: event.receivedAt, eventId: { lt: event.eventId } }
        ]
      }, orderBy: [{ receivedAt: "asc" }, { eventId: "asc" }] });
      if (earlierEvent) {
        await tx.webhookEvent.update({ where: { id: event.id }, data: {
          reason: "WAITING_PRIOR_EVENT",
          nextAttemptAt: new Date(cycleTime.getTime() + 1_000)
        } });
        return;
      }

      const purchaseTime = event.occurredAt ?? event.receivedAt;
      const timeSource = event.occurredAt ? "OCCURRED_AT" : "RECEIVED_AT";
      let session: TrackingSession | null = null;
      let reason: AttributionReason = "NO_MATCH";
      if (input.sessionId) {
        session = await tx.trackingSession.findUnique({ where: { sessionId: input.sessionId } });
        if (!session) {
          const deadline = event.trackingDeadline ?? new Date(event.receivedAt.getTime() + config.trackingWaitMs);
          if (cycleTime < deadline) {
            await tx.webhookEvent.update({ where: { id: event.id }, data: {
              status: "WAITING_TRACKING", reason: "TRACKING_PENDING", trackingDeadline: deadline,
              nextAttemptAt: new Date(Math.min(cycleTime.getTime() + 1_000, deadline.getTime()))
            } });
            return;
          }
          reason = "SESSION_NOT_FOUND";
        } else if (sessionTime(session) > purchaseTime) {
          session = null;
          reason = "SESSION_AFTER_ORDER";
        } else {
          reason = "SESSION_ID_MATCH";
        }
      }
      if (!session && reason !== "SESSION_AFTER_ORDER" && input.customerEmailHash) {
        const windowStart = new Date(purchaseTime.getTime() - config.attributionWindowMinutes * 60_000);
        const candidates = (await tx.trackingSession.findMany({
          where: { customerEmailHash: input.customerEmailHash }
        })).filter((candidate) => sessionTime(candidate) >= windowStart && sessionTime(candidate) <= purchaseTime);
        if (candidates.length === 1) {
          session = candidates[0] ?? null;
          reason = "CUSTOMER_MATCH";
        } else if (candidates.length > 1) reason = "AMBIGUOUS_CUSTOMER_MATCH";
      }
      const snapshot = buildAttribution(input, session, reason, timeSource);
      const order = await tx.order.create({ data: {
        orderId: input.orderId, amount: BigInt(input.amount), currency: input.currency,
        occurredAt: purchaseTime, timeSource, attributionStatus: snapshot.status,
        trackingSessionId: snapshot.status === "ATTRIBUTED" ? session!.id : null,
        attribution: snapshot as unknown as Prisma.InputJsonObject,
        conversionContext: { pageUrl: snapshot.status === "ATTRIBUTED" ? session!.pageUrl : null, emailHash: snapshot.status === "ATTRIBUTED" ? session!.customerEmailHash : null, phoneHash: snapshot.status === "ATTRIBUTED" ? session!.customerPhoneHash : null, source: "ORDER_SNAPSHOT" }
      } });
      await hooks.afterOrderCreated?.();
      await tx.conversionDelivery.createMany({ data: providers.map((provider) => ({
        orderDbId: order.id, provider, type: "PURCHASE", status: "PENDING" as const,
        scenario: event.scenario,
        payloadSchemaVersion: provider === "UTMIFY" ? "utmify-demo-v1" : `${provider.toLowerCase()}-demo-v1`,
        conversionId: createHash("sha256").update(`${input.orderId}:PURCHASE:${provider}`).digest("hex")
      })) });
      await tx.webhookEvent.update({ where: { id: event.id }, data: {
        status: "PROCESSED", reason: null, orderDbId: order.id, lastError: null
      } });
    });
  }

  async function runOnce(): Promise<boolean> {
    const cycleTime = now();
    const event = await prisma.webhookEvent.findFirst({ where: {
      status: { in: ["PENDING", "WAITING_TRACKING"] }, nextAttemptAt: { lte: cycleTime }
    }, orderBy: [{ nextAttemptAt: "asc" }, { receivedAt: "asc" }, { eventId: "asc" }] });
    if (!event) return false;
    try {
      await processEvent(event.eventId, cycleTime);
    } catch {
      const retryCount = event.retryCount + 1;
      await prisma.webhookEvent.updateMany({ where: {
        id: event.id, status: { in: ["PENDING", "WAITING_TRACKING"] }
      }, data: {
        retryCount,
        status: retryCount >= config.maxProcessingRetries ? "FAILED" : "PENDING",
        reason: "PROCESSING_ERROR",
        lastError: "Processing failed; details withheld",
        nextAttemptAt: new Date(cycleTime.getTime() + Math.min(retryCount * 1_000, 5_000))
      } });
    }
    return true;
  }
  return { runOnce };
}
