import { describe, expect, it } from "vitest";

import { protectTransportData } from "../../src/application/conversions/providers.js";

describe("conversion support privacy boundary", () => {
  it("keeps only prehashed matching signals and hides raw contact data and credentials", () => {
    const hash = "a".repeat(64);
    expect(protectTransportData({ headers: { Authorization: "Bearer secret" }, body: { user_data: { em: [hash], ph: ["+15550100"], email: "buyer@example.test" } } })).toEqual({
      headers: { Authorization: "[REDACTED]" },
      body: { user_data: { em: [hash], ph: "[REDACTED]", email: "[REDACTED]" } }
    });
  });
});
