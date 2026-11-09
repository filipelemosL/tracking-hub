import { sanitizeSupportValue } from "../../application/support/sanitize-support.js";

export function systemLog(kind: string, details: Record<string, unknown>): void {
  try {
    console.info(`[tracking-hub] ${JSON.stringify({ at: new Date().toISOString(), kind, details: sanitizeSupportValue(details) })}`);
  } catch {
    console.info(`[tracking-hub] ${JSON.stringify({ at: new Date().toISOString(), kind, details: "[LOG_UNAVAILABLE]" })}`);
  }
}
