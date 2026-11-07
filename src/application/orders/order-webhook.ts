import { Prisma } from "@prisma/client";

export type NormalizedOrderWebhook = {
  eventId: string;
  event: "ORDER_PAID";
  orderId: string;
  amount: number;
  currency: string;
  sessionId: string | null;
  occurredAt: string | null;
  customerEmailHash: string | null;
  customFields: Record<string, unknown>;
};

export type StoredWebhook = {
  normalized: NormalizedOrderWebhook;
  receivedAt: Date;
};

export type WebhookRepository = {
  findByEventId(eventId: string): Promise<StoredWebhook | null>;
  create(input: NormalizedOrderWebhook, original: Record<string, unknown>, receivedAt: Date): Promise<void>;
};

export class WebhookConflictError extends Error {
  constructor() { super("Webhook event differs from the original"); }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function receiveOrderWebhook(
  repository: WebhookRepository,
  input: NormalizedOrderWebhook,
  original: Record<string, unknown>,
  receivedAt: Date
): Promise<{ duplicate: boolean }> {
  const existing = await repository.findByEventId(input.eventId);
  if (existing) {
    if (canonicalJson(existing.normalized) !== canonicalJson(input)) throw new WebhookConflictError();
    return { duplicate: true };
  }
  try {
    await repository.create(input, original, receivedAt);
    return { duplicate: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const winner = await repository.findByEventId(input.eventId);
    if (!winner) throw error;
    if (canonicalJson(winner.normalized) !== canonicalJson(input)) throw new WebhookConflictError();
    return { duplicate: true };
  }
}
