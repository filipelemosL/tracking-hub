const REDACTED = "[REDACTED]";
const normalizedKey = (key: string) => key.replace(/[^a-z0-9]/gi, "").toLowerCase();
const isSecretKey = (key: string) => /authorization|apikey|accesskey|privatekey|token|password|passwd|secret|credential|cookie|bearer|connectionstring|jwt/.test(normalizedKey(key));
const isContactKey = (key: string) => /^(?:em|ph|email|emailhash|customeremailhash|phone|phonehash|customerphonehash|telephone|mobile|address|fullname)$/.test(normalizedKey(key));
const emailText = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/;
const phoneText = /\+\d[\d\s().-]{6,}\d/;
const secretText = /(?:bearer\s+\S+|(?:postgres(?:ql)?|mysql|mongodb):\/\/|(?:authorization|cookie|api[_-]?key|token|password|secret)\s*[:=]\s*\S+|sk_(?:live|test)_\S+)/i;
const hash = /^[a-f0-9]{64}$/i;
const MAX_STRING = 1024;
const MAX_ENTRIES = 40;
const MAX_DEPTH = 10;

function isAllowedHash(provider: string | undefined, path: string[], value: unknown): boolean {
  const location = path.join(".");
  const allowed = provider === "META"
    ? /^body\.data\.\d+\.user_data\.(?:em|ph)$/
    : provider === "TIKTOK"
      ? /^body\.data\.\d+\.user\.(?:email|phone)$/
      : /^$/;
  return allowed.test(location) && (
    typeof value === "string" && hash.test(value) ||
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && hash.test(item))
  );
}

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return REDACTED;
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const [key, value] of url.searchParams) {
      if (isSecretKey(key) || normalizedKey(key) === "session" || isContactKey(key) || emailText.test(value) || phoneText.test(value) || secretText.test(value)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    const segments = url.pathname.split("/").map((segment) =>
      emailText.test(decodeURIComponent(segment)) || phoneText.test(decodeURIComponent(segment)) ? REDACTED : segment);
    url.pathname = segments.join("/");
    if (url.hash && (emailText.test(url.hash) || secretText.test(url.hash))) url.hash = REDACTED;
    return url.toString();
  } catch {
    return REDACTED;
  }
}

function sanitizeString(value: string): string {
  if (/^https?:\/\//i.test(value)) return sanitizeUrl(value);
  if (emailText.test(value) || phoneText.test(value) || secretText.test(value) || /\n\s*at\s+\S+/.test(value)) return REDACTED;
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}[TRUNCATED]` : value;
}

function sanitize(value: unknown, provider: string | undefined, path: string[], depth: number): unknown {
  if (depth > MAX_DEPTH) return { truncated: true, reason: "DEPTH_LIMIT" };
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((item, index) => sanitize(item, provider, [...path, String(index)], depth + 1));
    if (value.length > MAX_ENTRIES) items.push({ truncated: true, omitted: value.length - MAX_ENTRIES });
    return items;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).slice(0, MAX_ENTRIES);
    const output: Record<string, unknown> = {};
    const field = (value as Record<string, unknown>).field;
    for (const [key, item] of entries) {
      const childPath = [...path, key];
      if (isSecretKey(key) || path.at(-1) === "query" && normalizedKey(key) === "session") {
        output[key] = REDACTED;
      } else if (isContactKey(key) || typeof field === "string" && isContactKey(field) && (key === "webhookValue" || key === "sessionValue")) {
        output[key] = isAllowedHash(provider, childPath, item) ? item : REDACTED;
      } else if (key === "url" || /url$/i.test(key)) {
        output[key] = typeof item === "string" ? sanitizeUrl(item) : REDACTED;
      } else {
        output[key] = sanitize(item, provider, childPath, depth + 1);
      }
    }
    if (Object.keys(value).length > MAX_ENTRIES) output._truncated = { omitted: Object.keys(value).length - MAX_ENTRIES };
    return output;
  }
  return value;
}

export function sanitizeSupportValue(value: unknown, provider?: string): unknown {
  return sanitize(value, provider, [], 0);
}
