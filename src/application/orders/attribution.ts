import type { TrackingSession } from "@prisma/client";

import type { NormalizedOrderWebhook } from "./order-webhook.js";
import { identifierNames } from "../tracking/capture-session.js";
import { canonicalJson } from "./order-webhook.js";

export type AttributionReason =
  "SESSION_ID_MATCH" | "CUSTOMER_MATCH" | "NO_MATCH" |
  "AMBIGUOUS_CUSTOMER_MATCH" | "SESSION_AFTER_ORDER" | "SESSION_NOT_FOUND";

export type AttributionSnapshot = {
  status: "ATTRIBUTED" | "UNATTRIBUTED";
  method: "SESSION_ID" | "CUSTOMER" | "NONE";
  reason: AttributionReason;
  sessionId: string | null;
  requestedSessionId: string | null;
  customFields: Record<string, unknown>;
  identifiers: Record<string, string>;
  provenance: Record<string, string>;
  evidence: Record<string, { source: "TRACKING_SESSION" | "WEBHOOK"; sourceId: string; path: string }>;
  customFieldConflicts: Array<{ field: string; webhookValue: unknown; sessionValue: unknown }>;
  timeSource: "OCCURRED_AT" | "RECEIVED_AT";
};

export function sessionTime(session: TrackingSession): Date {
  return session.capturedAt ?? session.receivedAt;
}

export function buildAttribution(
  input: NormalizedOrderWebhook,
  session: TrackingSession | null,
  reason: AttributionReason,
  timeSource: "OCCURRED_AT" | "RECEIVED_AT"
): AttributionSnapshot {
  const webhookFields = input.customFields;
  const sessionFields = session?.customFields as Record<string, unknown> | undefined;
  const useWebhook = Object.values(webhookFields).some((value) =>
    value !== null && value !== "" && (typeof value !== "string" || value.trim() !== ""));
  const customFields = useWebhook ? webhookFields : (sessionFields ?? {});
  const customFieldSource = useWebhook ? "webhook.customFields" : "trackingSession.customFields";
  const identifiers: Record<string, string> = {};
  const provenance: Record<string, string> = {};
  const evidence: AttributionSnapshot["evidence"] = {};
  const hasValue = (value: unknown) => value !== null && value !== undefined && value !== "";
  if (session) {
    for (const name of identifierNames) {
      const value = session[name];
      if (value !== null) {
        identifiers[name] = value;
        provenance[`identifiers.${name}`] = `trackingSession.identifiers.${name}`;
        if (hasValue(value)) evidence[`identifiers.${name}`] = {
          source: "TRACKING_SESSION", sourceId: session.sessionId, path: `identifiers.${name}`
        };
      }
    }
  }
  for (const field of Object.keys(customFields)) {
    provenance[`customFields.${field}`] = `${customFieldSource}.${field}`;
    if (hasValue(customFields[field])) evidence[`customFields.${field}`] = {
      source: useWebhook ? "WEBHOOK" : "TRACKING_SESSION",
      sourceId: useWebhook ? input.eventId : session!.sessionId,
      path: `customFields.${field}`
    };
  }
  const customFieldConflicts = sessionFields && useWebhook
    ? Object.keys(webhookFields).filter((field) =>
      Object.hasOwn(sessionFields, field) &&
      canonicalJson(webhookFields[field]) !== canonicalJson(sessionFields[field]))
      .map((field) => ({ field, webhookValue: webhookFields[field], sessionValue: sessionFields[field] }))
    : [];
  const attributed = reason === "SESSION_ID_MATCH" || reason === "CUSTOMER_MATCH";
  provenance["purchaseTime"] = timeSource === "OCCURRED_AT" ? "webhook.occurredAt" : "webhook.receivedAt";
  if (input.sessionId) provenance["requestedSessionId"] = "webhook.sessionId";
  if (attributed) provenance["sessionId"] = reason === "SESSION_ID_MATCH" ? "webhook.sessionId" : "trackingSession.customerEmailHash";
  return {
    status: attributed ? "ATTRIBUTED" : "UNATTRIBUTED",
    method: reason === "SESSION_ID_MATCH" ? "SESSION_ID" : reason === "CUSTOMER_MATCH" ? "CUSTOMER" : "NONE",
    reason,
    sessionId: attributed ? session?.sessionId ?? null : null,
    requestedSessionId: input.sessionId,
    customFields,
    identifiers: attributed ? identifiers : {},
    provenance: attributed ? provenance : Object.fromEntries(Object.entries(provenance).filter(([key]) =>
      key.startsWith("customFields.") || key === "purchaseTime" || key === "requestedSessionId")),
    evidence: attributed ? evidence : Object.fromEntries(Object.entries(evidence).filter(([key]) => key.startsWith("customFields."))),
    customFieldConflicts: attributed ? customFieldConflicts : [],
    timeSource
  };
}
