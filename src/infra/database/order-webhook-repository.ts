import { Prisma, type PrismaClient } from "@prisma/client";

import type { NormalizedOrderWebhook, WebhookRepository } from "../../application/orders/order-webhook.js";

export function orderWebhookRepository(prisma: PrismaClient): WebhookRepository {
  return {
    async findByEventId(eventId) {
      const row = await prisma.webhookEvent.findUnique({ where: { eventId } });
      return row ? { normalized: row.normalizedPayload as NormalizedOrderWebhook, receivedAt: row.receivedAt, scenario: row.scenario as import("../../application/conversions/providers.js").ConversionScenario } : null;
    },
    async create(input, original, receivedAt, scenario) {
      await prisma.webhookEvent.create({ data: {
        eventId: input.eventId,
        event: input.event,
        orderId: input.orderId,
        originalPayload: original as Prisma.InputJsonObject,
        normalizedPayload: input as unknown as Prisma.InputJsonObject,
        scenario,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
        receivedAt,
        nextAttemptAt: receivedAt
      } });
    }
  };
}
