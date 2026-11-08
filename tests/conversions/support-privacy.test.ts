import { describe, expect, it } from "vitest";

import { protectTransportData } from "../../src/application/conversions/providers.js";
import { sanitizeSupportValue } from "../../src/application/support/sanitize-support.js";

describe("conversion support privacy boundary", () => {
  it("keeps only prehashed matching signals and hides raw contact data and credentials", () => {
    const hash = "a".repeat(64);
    expect(protectTransportData({ headers: { Authorization: "Bearer secret" }, body: { user_data: { em: [hash], ph: ["+15550100"], email: "buyer@example.test" } } })).toEqual({
      headers: { Authorization: "[REDACTED]" },
      body: { user_data: { em: [hash], ph: "[REDACTED]", email: "[REDACTED]" } }
    });
  });

  it("authorizes hashes by adapter path, never by shape alone, without mutating the input", () => {
    const hash = "a".repeat(64);
    const input = {
      method: "POST", url: "https://meta.invalid/path?access_token=secret&source=facebook",
      headers: { Authorization: hash, "X-Api-Key": "key-secret" },
      body: { data: [{ user_data: { em: [hash], ph: [hash], fbc: "fb.1.click" } }], emailHash: hash },
      query: { clickid: "redtrack-click", session: "auth-session" }
    };
    const before = structuredClone(input);
    const result = sanitizeSupportValue(input, "META") as typeof input;
    expect(result.body.data[0]?.user_data).toEqual({ em: [hash], ph: [hash], fbc: "fb.1.click" });
    expect(result.body.emailHash).toBe("[REDACTED]");
    expect(result.headers.Authorization).toBe("[REDACTED]");
    expect(result.query).toEqual({ clickid: "redtrack-click", session: "[REDACTED]" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(input).toEqual(before);
    expect(sanitizeSupportValue({ body: { data: [{ user_data: { em: [hash] } }] } }, "GOOGLE")).toEqual({ body: { data: [{ user_data: { em: "[REDACTED]" } }] } });
  });
});
