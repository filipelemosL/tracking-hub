import { afterEach, describe, expect, it, vi } from "vitest";

import { systemLog } from "../../src/infra/logging/system-log.js";

afterEach(() => vi.restoreAllMocks());

describe("worker console logs", () => {
  it("logs simulated transport metadata without exposing URL credentials or contact data", () => {
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    systemLog("conversion.request", { provider: "META", attemptNumber: 1, request: {
      method: "POST", url: "https://meta.invalid/path?access_token=url-secret",
      headers: { Authorization: "Bearer header-secret" },
      body: { data: [{ user_data: { em: ["a".repeat(64)] }, event_source_url: "https://example.test/?email=buyer@example.test" }] }
    } });
    const line = String(logged.mock.calls[0]?.[0]);
    const entry = JSON.parse(line.slice("[tracking-hub] ".length)) as { kind: string; details: { provider: string; request: { headers: { Authorization: string } } } };
    expect(entry.kind).toBe("conversion.request");
    expect(entry.details.provider).toBe("META");
    expect(entry.details.request.headers.Authorization).toBe("[REDACTED]");
    expect(line).not.toMatch(/url-secret|header-secret|buyer@example\.test/);
  });
});
