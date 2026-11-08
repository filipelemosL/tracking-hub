import { Prisma, type PrismaClient } from "@prisma/client";

import { sanitizeSupportValue } from "../../application/support/sanitize-support.js";

type Evidence = { source: "TRACKING_SESSION" | "WEBHOOK" | "UNKNOWN"; sourceId: string | null; path: string | null };
type Snapshot = {
  identifiers?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
  evidence?: Record<string, Evidence>;
  [key: string]: unknown;
};

function withEvidence(raw: unknown): Snapshot {
  const snapshot = raw as Snapshot;
  const evidence: Record<string, Evidence> = {};
  for (const group of ["identifiers", "customFields"] as const) {
    for (const [field, value] of Object.entries(snapshot[group] ?? {})) {
      if (value === null || value === undefined || value === "") continue;
      const key = `${group}.${field}`;
      const saved = snapshot.evidence?.[key];
      evidence[key] = saved && (saved.source === "TRACKING_SESSION" || saved.source === "WEBHOOK") &&
        typeof saved.sourceId === "string" && typeof saved.path === "string"
        ? { source: saved.source, sourceId: saved.sourceId, path: saved.path }
        : { source: "UNKNOWN", sourceId: null, path: null };
    }
  }
  return { ...snapshot, evidence };
}

export type SupportReadHooks = { afterOrderRead?: () => Promise<void> };

export function orderSupportRepository(prisma: PrismaClient, hooks: SupportReadHooks = {}) {
  return async (orderId: string): Promise<{ status: number; body: unknown }> => prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { orderId },
      select: {
        orderId: true, amount: true, currency: true, occurredAt: true, timeSource: true, attribution: true,
        deliveries: {
          orderBy: [{ provider: "asc" }, { id: "asc" }],
          select: {
            provider: true, type: true, conversionId: true, status: true, reason: true,
            nextAttemptAt: true, transportMode: true, payloadSchemaVersion: true, frozenRequest: true,
            attempts: {
              orderBy: [{ attemptNumber: "asc" }, { id: "asc" }],
              select: {
                attemptNumber: true, status: true, startedAt: true, finishedAt: true,
                httpStatus: true, errorCode: true, response: true, request: true, requestDigest: true
              }
            }
          }
        }
      }
    });
    await hooks.afterOrderRead?.();
    const events = await tx.webhookEvent.findMany({
      where: { orderId },
      orderBy: [{ receivedAt: "asc" }, { eventId: "asc" }],
      select: {
        eventId: true, status: true, reason: true, retryCount: true, nextAttemptAt: true,
        trackingDeadline: true, lastError: true
      }
    });
    if (!order && events.length === 0) return { status: 404, body: { code: "ORDER_NOT_FOUND" } };
    const webhookEvents = events.map((event) => ({
      eventId: event.eventId, status: event.status, reason: event.reason,
      retryCount: event.retryCount, nextAttemptAt: event.nextAttemptAt.toISOString(),
      trackingDeadline: event.trackingDeadline?.toISOString() ?? null,
      error: sanitizeSupportValue(event.lastError)
    }));
    if (!order) {
      const terminal = events.every((event) => event.status === "FAILED" || event.status === "CONFLICT");
      return { status: terminal ? 200 : 202, body: {
        orderId,
        processingStatus: terminal ? "FAILED" : events.some((event) => event.status === "WAITING_TRACKING")
          ? "WAITING_TRACKING" : "PENDING",
        webhookEvents
      } };
    }
    return { status: 200, body: {
      order: {
        orderId: order.orderId, amount: Number(order.amount), currency: order.currency,
        occurredAt: order.occurredAt.toISOString(), timeSource: order.timeSource
      },
      attribution: sanitizeSupportValue(withEvidence(order.attribution)),
      webhookEvents,
      deliveries: [...order.deliveries].sort((left, right) => left.provider.localeCompare(right.provider) || left.type.localeCompare(right.type)).map((delivery) => ({
        provider: delivery.provider, type: delivery.type, conversionId: delivery.conversionId,
        status: delivery.status, reason: delivery.reason,
        nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
        transportMode: delivery.transportMode, payloadSchemaVersion: delivery.payloadSchemaVersion,
        attempts: delivery.attempts.map((attempt) => ({
          attemptNumber: attempt.attemptNumber, status: attempt.status,
          startedAt: attempt.startedAt.toISOString(), finishedAt: attempt.finishedAt?.toISOString() ?? null,
          httpStatus: attempt.httpStatus, errorCode: sanitizeSupportValue(attempt.errorCode),
          response: sanitizeSupportValue(attempt.response),
          request: sanitizeSupportValue(delivery.frozenRequest ?? attempt.request, delivery.provider),
          requestDigest: attempt.requestDigest
        }))
      }))
    } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
