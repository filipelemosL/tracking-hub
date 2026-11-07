import { createHash } from "node:crypto";

import { canonicalJson } from "../orders/order-webhook.js";

export const scenarios = ["SUCCESS", "META_RETRY_ONCE", "GOOGLE_RATE_LIMIT_ONCE", "TIKTOK_PERMANENT", "META_ALWAYS_503", "META_TIMEOUT", "GOOGLE_APPLICATION_ERROR"] as const;
export type ConversionScenario = typeof scenarios[number];
export type ProviderName = "META" | "GOOGLE" | "TIKTOK" | "UTMIFY" | "REDTRACK";
export type LogicalRequest = { method: "POST" | "GET"; url: string; headers: Record<string, string>; body?: unknown; query?: Record<string, string>; correlation?: Record<string, string> };
export type ConversionEvent = {
  provider: ProviderName;
  orderId: string;
  conversionId: string;
  occurredAt: Date;
  amountInCents: bigint;
  currency: string;
  attribution: { identifiers: Record<string, string>; customFields: Record<string, unknown> };
  context: { pageUrl?: string | null; emailHash?: string | null; phoneHash?: string | null };
  scenario: ConversionScenario;
  attemptNumber: number;
  request?: LogicalRequest;
};
export type ProviderResult = { outcome: "ACCEPTED" | "TEMPORARY" | "PERMANENT" | "UNCERTAIN"; httpStatus: number | null; response: unknown; errorCode: string | null; retryAfter?: string | null };
export type PreparedRequest = { request?: LogicalRequest; skipReason?: string; schemaVersion: string };
export type ConversionProvider = { prepare(event: ConversionEvent): PreparedRequest; send(event: ConversionEvent): Promise<ProviderResult> };
type TransportResponse = { status: number | null; body: Record<string, unknown> | null; headers: Record<string, string>; errorCode?: string };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const requestDigest = (request: LogicalRequest) => sha256(canonicalJson(request));
const money = (cents: bigint) => Number(cents) / 100;
const stringField = (fields: Record<string, unknown>, key: string): string | undefined => typeof fields[key] === "string" && fields[key] ? fields[key] as string : undefined;
const matchingHash = (hash?: string | null) => hash && /^[a-f0-9]{64}$/i.test(hash) ? hash.toLowerCase() : undefined;

function prepare(event: ConversionEvent): PreparedRequest {
  const ids = event.attribution.identifiers;
  const fields = event.attribution.customFields;
  const pageUrl = event.context.pageUrl;
  const email = matchingHash(event.context.emailHash);
  const phone = matchingHash(event.context.phoneHash);
  const seconds = Math.floor(event.occurredAt.getTime() / 1000);
  const value = money(event.amountInCents);
  const headers = { "content-type": "application/json" };
  switch (event.provider) {
    case "META": {
      if (!pageUrl || !(ids.fbc || ids.fbp || email || phone)) return { skipReason: "MISSING_MATCHING_DATA", schemaVersion: "meta-demo-v1" };
      return { schemaVersion: "meta-demo-v1", request: { method: "POST", url: "https://meta.invalid/conversions", headers, body: { data: [{ event_name: "Purchase", event_id: event.conversionId, event_time: seconds, action_source: "website", event_source_url: pageUrl, custom_data: { value, currency: event.currency }, user_data: { ...(ids.fbc && { fbc: ids.fbc }), ...(ids.fbp && { fbp: ids.fbp }), ...(email && { em: [email] }), ...(phone && { ph: [phone] }) } }] } } };
    }
    case "GOOGLE": {
      if (!(ids.gclid || ids.gbraid || ids.wbraid)) return { skipReason: "MISSING_CLICK_ID", schemaVersion: "google-demo-v1" };
      return { schemaVersion: "google-demo-v1", request: { method: "POST", url: "https://google.invalid/click-conversions:upload", headers, body: { partialFailure: true, conversions: [{ conversionAction: "customers/demo/conversionActions/purchase", conversionDateTime: event.occurredAt.toISOString().replace("T", " ").replace("Z", "+00:00"), conversionValue: value, currencyCode: event.currency, orderId: event.orderId, ...(ids.gclid && { gclid: ids.gclid }), ...(ids.gbraid && { gbraid: ids.gbraid }), ...(ids.wbraid && { wbraid: ids.wbraid }) }] } } };
    }
    case "TIKTOK": {
      if (!pageUrl || !(ids.ttclid || ids.ttp || email || phone)) return { skipReason: "MISSING_MATCHING_DATA", schemaVersion: "tiktok-demo-v1" };
      return { schemaVersion: "tiktok-demo-v1", request: { method: "POST", url: "https://tiktok.invalid/events", headers, body: { event_source: "web", event_source_id: "demo-pixel", data: [{ event: "Purchase", event_id: event.conversionId, event_time: seconds, user: { ...(ids.ttclid && { ttclid: ids.ttclid }), ...(ids.ttp && { ttp: ids.ttp }), ...(email && { email }), ...(phone && { phone }) }, page: { url: pageUrl }, properties: { value, currency: event.currency } }] } } };
    }
    case "UTMIFY": {
      const trackingParameters = Object.fromEntries(Object.entries({ utm_source: stringField(fields, "source"), utm_campaign: stringField(fields, "campaign"), utm_content: stringField(fields, "content"), utm_medium: stringField(fields, "medium"), utm_term: stringField(fields, "term") }).filter(([, val]) => val !== undefined));
      return { schemaVersion: "utmify-demo-v1", request: { method: "POST", url: "https://utmify.invalid/orders", headers, body: { orderId: event.orderId, status: "paid", approvedDate: event.occurredAt.toISOString(), amountInCents: Number(event.amountInCents), currency: event.currency, trackingParameters, metadata: { ...(ids.utmifyId && { utmifyId: ids.utmifyId }), ...(stringField(fields, "affiliateCode") && { affiliateCode: stringField(fields, "affiliateCode") }) } } } };
    }
    case "REDTRACK": {
      if (!ids.redtrackClickId) return { skipReason: "MISSING_REDTRACK_CLICK_ID", schemaVersion: "redtrack-demo-v1" };
      return { schemaVersion: "redtrack-demo-v1", request: { method: "GET", url: "https://redtrack.invalid/postback", headers: {}, query: { clickid: ids.redtrackClickId }, correlation: { orderId: event.orderId, conversionId: event.conversionId } } };
    }
  }
}

async function simulatedTransport(event: ConversionEvent, _request: LogicalRequest, _timeoutMs: number): Promise<TransportResponse> {
  const { provider, scenario, attemptNumber } = event;
  if (provider === "META" && scenario === "META_TIMEOUT" && attemptNumber === 1) return { status: null, body: null, headers: {}, errorCode: "TRANSPORT_TIMEOUT" };
  if (provider === "META" && (scenario === "META_ALWAYS_503" || scenario === "META_RETRY_ONCE" && attemptNumber === 1)) return { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE" } }, headers: {} };
  if (provider === "GOOGLE" && scenario === "GOOGLE_RATE_LIMIT_ONCE" && attemptNumber === 1) return { status: 429, body: { error: { code: "RATE_LIMITED" } }, headers: { "retry-after": "1" } };
  if (provider === "TIKTOK" && scenario === "TIKTOK_PERMANENT") return { status: 400, body: { code: "INVALID_PAYLOAD" }, headers: {} };
  if (provider === "GOOGLE" && scenario === "GOOGLE_APPLICATION_ERROR") return { status: 200, body: { partialFailureError: { code: "SIMULATED_INVALID_CONVERSION_ACTION" }, results: [] }, headers: {} };
  return { status: 200, body: provider === "GOOGLE" ? { results: [{ accepted: true }] } : provider === "TIKTOK" ? { code: 0, message: "OK" } : { accepted: true }, headers: {} };
}

async function sendWithTimeout(event: ConversionEvent, request: LogicalRequest, timeoutMs: number): Promise<TransportResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      simulatedTransport(event, request, timeoutMs),
      new Promise<TransportResponse>((resolve) => {
        timer = setTimeout(() => resolve({ status: null, body: null, headers: {}, errorCode: "TRANSPORT_TIMEOUT" }), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classify(provider: ProviderName, result: TransportResponse): ProviderResult {
  if (result.status === null) return { outcome: "UNCERTAIN", httpStatus: null, response: result.body, errorCode: result.errorCode ?? "TRANSPORT_UNKNOWN" };
  const body = result.body ?? {};
  const error = body.error as Record<string, unknown> | undefined;
  const code = typeof body.code === "string" ? body.code : typeof error?.code === "string" ? error.code : null;
  if (result.status === 429 || result.status >= 500) return { outcome: "TEMPORARY", httpStatus: result.status, response: body, errorCode: code ?? `HTTP_${result.status}`, retryAfter: result.headers["retry-after"] ?? null };
  if (result.status >= 400) return { outcome: "PERMANENT", httpStatus: result.status, response: body, errorCode: code ?? `HTTP_${result.status}` };
  if (provider === "GOOGLE") {
    const partial = body.partialFailureError as Record<string, unknown> | undefined;
    if (partial) return { outcome: "PERMANENT", httpStatus: result.status, response: body, errorCode: String(partial.code ?? "GOOGLE_PARTIAL_FAILURE") };
    if (!Array.isArray(body.results) || body.results.length !== 1) return { outcome: "PERMANENT", httpStatus: result.status, response: body, errorCode: "GOOGLE_ITEM_NOT_ACCEPTED" };
  }
  if (provider === "TIKTOK" && body.code !== 0) return { outcome: "PERMANENT", httpStatus: result.status, response: body, errorCode: code ?? "TIKTOK_APPLICATION_ERROR" };
  if (provider !== "GOOGLE" && provider !== "TIKTOK" && body.accepted !== true) return { outcome: "PERMANENT", httpStatus: result.status, response: body, errorCode: "ITEM_NOT_ACCEPTED" };
  return { outcome: "ACCEPTED", httpStatus: result.status, response: body, errorCode: null };
}

export function createConversionProviders(timeoutMs: number): Record<ProviderName, ConversionProvider> {
  return Object.fromEntries((["META", "GOOGLE", "TIKTOK", "UTMIFY", "REDTRACK"] as ProviderName[]).map((provider) => [provider, {
    prepare,
    async send(event: ConversionEvent) {
      if (!event.request) throw new Error("Prepared request missing");
      return classify(provider, await sendWithTimeout(event, event.request, timeoutMs));
    }
  }])) as Record<ProviderName, ConversionProvider>;
}

export function protectTransportData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(protectTransportData);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(em|ph|email|phone|authorization|access.token|api.key)$/i.test(key) ? "[REDACTED]" : protectTransportData(item)]));
  return value;
}
