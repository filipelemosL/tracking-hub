import { hashCustomer } from "../application/tracking/capture-session.js";
import type { NormalizedOrderWebhook } from "../application/orders/order-webhook.js";

export class OrderWebhookValidationError extends Error {
  constructor(public readonly fields: string[]) { super("Invalid order webhook"); }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validateOrderWebhook(body: unknown, receivedAt: Date): NormalizedOrderWebhook {
  if (!isObject(body)) throw new OrderWebhookValidationError(["body"]);
  const invalid = new Set<string>();
  const requiredId = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !value.trim() || value.length > 128) {
      invalid.add(name);
      return "";
    }
    return value.trim();
  };
  const eventId = requiredId(body.eventId, "eventId");
  const orderId = requiredId(body.orderId, "orderId");
  if (body.event !== "ORDER_PAID") invalid.add("event");
  if (typeof body.amount !== "number" || !Number.isSafeInteger(body.amount) || body.amount <= 0) invalid.add("amount");
  if (typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency)) invalid.add("currency");

  let sessionId: string | null = null;
  if (body.sessionId !== undefined && body.sessionId !== null) {
    if (typeof body.sessionId !== "string" || body.sessionId.length > 128) invalid.add("sessionId");
    else sessionId = body.sessionId.trim() || null;
  }
  const customFields = body.customFields === undefined ? {} : body.customFields;
  if (!isObject(customFields) || Buffer.byteLength(JSON.stringify(customFields)) > 16_384) invalid.add("customFields");
  const customer = body.customer === undefined ? {} : body.customer;
  if (!isObject(customer)) invalid.add("customer");
  let emailHash: string | null = null;
  if (isObject(customer) && customer.email !== undefined && customer.email !== null) {
    if (typeof customer.email !== "string" || customer.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email.trim())) invalid.add("customer.email");
    else emailHash = hashCustomer(customer.email.trim().toLowerCase());
  }

  let occurredAt: string | null = null;
  if (body.occurredAt !== undefined && body.occurredAt !== null) {
    const match = typeof body.occurredAt === "string" &&
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(body.occurredAt);
    if (!match) invalid.add("occurredAt");
    else {
      const [, year, month, day, hour, minute, second, zone] = match;
      const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
      const date = new Date(match[0]);
      if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days ||
        Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
        (zone !== "Z" && (Number(zone?.slice(1, 3)) > 23 || Number(zone?.slice(4, 6)) > 59)) ||
        Number.isNaN(date.getTime()) || date.getTime() > receivedAt.getTime() + 300_000) invalid.add("occurredAt");
      else occurredAt = date.toISOString();
    }
  }
  if (invalid.size) throw new OrderWebhookValidationError([...invalid].sort());
  return {
    eventId, event: "ORDER_PAID", orderId, amount: body.amount as number,
    currency: body.currency as string, sessionId, occurredAt,
    customerEmailHash: emailHash, customFields: customFields as Record<string, unknown>
  };
}
