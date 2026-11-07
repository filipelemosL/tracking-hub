import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

export const identifierNames = [
  "fbclid", "fbc", "fbp", "gclid", "gbraid", "wbraid", "ttclid", "ttp",
  "redtrackClickId", "utmifyId"
] as const;

export type IdentifierName = (typeof identifierNames)[number];
export type CaptureInput = {
  sessionId: string;
  visitorId: string | null;
  capturedAt: Date | null;
  pageUrl: string;
  customFields: Record<string, unknown>;
  identifiers: Record<IdentifierName, string | null>;
  customerEmailHash: string | null;
  customerPhoneHash: string | null;
};

export type StoredCapture = CaptureInput & { receivedAt: Date };
export type CaptureRepository = {
  findBySessionId(sessionId: string): Promise<StoredCapture | null>;
  create(input: CaptureInput, receivedAt: Date): Promise<StoredCapture>;
};

export class CaptureConflictError extends Error {
  constructor() {
    super("Session capture differs from the original");
  }
}

export function hashCustomer(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equivalent(input: CaptureInput, stored: StoredCapture): boolean {
  return input.sessionId === stored.sessionId &&
    input.visitorId === stored.visitorId &&
    input.capturedAt?.getTime() === stored.capturedAt?.getTime() &&
    input.pageUrl === stored.pageUrl &&
    canonicalJson(input.customFields) === canonicalJson(stored.customFields) &&
    identifierNames.every((name) => input.identifiers[name] === stored.identifiers[name]) &&
    input.customerEmailHash === stored.customerEmailHash &&
    input.customerPhoneHash === stored.customerPhoneHash;
}

export async function captureSession(
  repository: CaptureRepository,
  input: CaptureInput,
  receivedAt: Date
): Promise<{ capture: StoredCapture; created: boolean }> {
  const existing = await repository.findBySessionId(input.sessionId);
  if (existing) {
    if (!equivalent(input, existing)) throw new CaptureConflictError();
    return { capture: existing, created: false };
  }

  try {
    return { capture: await repository.create(input, receivedAt), created: true };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    // The failed INSERT has ended. Re-read outside a failed transaction.
    const winner = await repository.findBySessionId(input.sessionId);
    if (!winner) throw error;
    if (!equivalent(input, winner)) throw new CaptureConflictError();
    return { capture: winner, created: false };
  }
}
