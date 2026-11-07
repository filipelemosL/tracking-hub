import type { PrismaClient } from "@prisma/client";

function protect(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(protect);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.field === "string" && /email|phone|address|full.?name/i.test(record.field)) {
      return { ...record, webhookValue: "[REDACTED]", sessionValue: "[REDACTED]" };
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [
      key, /email|phone|address|full.?name/i.test(key) ? "[REDACTED]" : protect(item)
    ]));
  }
  return value;
}

export function orderSupportRepository(prisma: PrismaClient) {
  return async (orderId: string): Promise<{ status: number; body: unknown }> => {
    const [order, events] = await Promise.all([
      prisma.order.findUnique({ where: { orderId }, include: { deliveries: { orderBy: { provider: "asc" } } } }),
      prisma.webhookEvent.findMany({ where: { orderId }, orderBy: { receivedAt: "asc" } })
    ]);
    if (!order && events.length === 0) return { status: 404, body: { code: "ORDER_NOT_FOUND" } };
    if (!order) {
      const terminal = events.every((event) => event.status === "FAILED" || event.status === "CONFLICT");
      return { status: terminal ? 200 : 202, body: {
        orderId,
        processingStatus: terminal ? "FAILED" : events.some((event) => event.status === "WAITING_TRACKING")
          ? "WAITING_TRACKING" : "PENDING",
        webhookEvents: events.map((event) => ({
          eventId: event.eventId, status: event.status, reason: event.reason,
          nextAttemptAt: event.nextAttemptAt.toISOString(),
          trackingDeadline: event.trackingDeadline?.toISOString() ?? null,
          retryCount: event.retryCount,
          error: event.lastError
        }))
      } };
    }
    return { status: 200, body: {
      order: {
        orderId: order.orderId, amount: Number(order.amount), currency: order.currency,
        occurredAt: order.occurredAt.toISOString(), timeSource: order.timeSource
      },
      attribution: protect(order.attribution),
      webhookEvents: events.map((event) => ({
        eventId: event.eventId, status: event.status, reason: event.reason,
        retryCount: event.retryCount, error: event.lastError
      })),
      deliveries: order.deliveries.map((delivery) => ({
        provider: delivery.provider, type: delivery.type,
        conversionId: delivery.conversionId, status: delivery.status, attempts: []
      }))
    } };
  };
}
