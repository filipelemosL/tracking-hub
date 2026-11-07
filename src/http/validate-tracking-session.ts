import { hashCustomer, identifierNames, type CaptureInput } from "../application/tracking/capture-session.js";

export class CaptureValidationError extends Error {
  constructor(public readonly fields: string[]) {
    super("Invalid tracking session capture");
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validateTrackingSession(body: unknown, receivedAt: Date): CaptureInput {
  const invalid = new Set<string>();
  if (!object(body)) throw new CaptureValidationError(["body"]);

  const string = (value: unknown, field: string, max: number, required = false): string | null => {
    if (value === undefined || value === null) {
      if (required) invalid.add(field);
      return null;
    }
    if (typeof value !== "string" || value.length > max) {
      invalid.add(field);
      return null;
    }
    if (value.trim() === "") {
      if (required) invalid.add(field);
      return null;
    }
    return value;
  };

  const sessionId = string(body.sessionId, "sessionId", 128, true)?.trim() ?? "";
  const visitorId = string(body.visitorId, "visitorId", 128)?.trim() ?? null;
  const pageUrl = string(body.pageUrl, "pageUrl", 2048, true)?.trim() ?? "";
  try {
    const url = new URL(pageUrl);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) invalid.add("pageUrl");
  } catch {
    invalid.add("pageUrl");
  }

  const customFields = body.customFields === undefined ? {} : body.customFields;
  if (!object(customFields) || Buffer.byteLength(JSON.stringify(customFields)) > 16_384) {
    invalid.add("customFields");
  }

  const rawIdentifiers = body.identifiers === undefined ? {} : body.identifiers;
  if (!object(rawIdentifiers)) invalid.add("identifiers");
  const identifiers = Object.fromEntries(identifierNames.map((name) => [
    name,
    string(object(rawIdentifiers) ? rawIdentifiers[name] : undefined, `identifiers.${name}`, 512)
  ])) as CaptureInput["identifiers"];

  const rawCustomer = body.customer === undefined ? {} : body.customer;
  if (!object(rawCustomer)) invalid.add("customer");
  const customer = object(rawCustomer) ? rawCustomer : {};
  const email = string(customer.email, "customer.email", 254);
  const phone = string(customer.phone, "customer.phone", 32);
  const normalizedEmail = email?.trim().toLowerCase() ?? null;
  if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) invalid.add("customer.email");
  const normalizedPhone = phone?.replace(/[\s().-]/g, "") ?? null;
  if (normalizedPhone && !/^\+?\d{7,15}$/.test(normalizedPhone)) invalid.add("customer.phone");

  let capturedAt: Date | null = null;
  if (body.capturedAt !== undefined && body.capturedAt !== null) {
    const match = typeof body.capturedAt === "string" &&
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(body.capturedAt);
    if (!match) {
      invalid.add("capturedAt");
    } else {
      const [, year, month, day, hour, minute, second, zone] = match;
      const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
      const zoneHour = zone === "Z" ? 0 : Number(zone?.slice(1, 3));
      const zoneMinute = zone === "Z" ? 0 : Number(zone?.slice(4, 6));
      capturedAt = new Date(match[0]);
      if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth ||
        Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
        zoneHour > 23 || zoneMinute > 59 || Number.isNaN(capturedAt.getTime()) ||
        capturedAt.getTime() > receivedAt.getTime() + 300_000) {
        invalid.add("capturedAt");
      }
    }
  }

  if (invalid.size) throw new CaptureValidationError([...invalid].sort());
  return {
    sessionId,
    visitorId,
    capturedAt,
    pageUrl,
    customFields: customFields as Record<string, unknown>,
    identifiers,
    customerEmailHash: normalizedEmail ? hashCustomer(normalizedEmail) : null,
    customerPhoneHash: normalizedPhone ? hashCustomer(normalizedPhone) : null
  };
}
