import { describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";

describe("loadEnv", () => {
  it("loads defaults for optional settings", () => {
    expect(loadEnv({ DATABASE_URL: "postgresql://localhost/tracking_hub" })).toEqual({
      nodeEnv: "development",
      port: 3000,
      databaseUrl: "postgresql://localhost/tracking_hub",
      workerPollIntervalMs: 1000,
      attributionWindowMinutes: 30,
      trackingWaitMs: 10000,
      maxProcessingRetries: 3,
      conversionMode: "simulated",
      enableTestScenarios: false,
      transportTimeoutMs: 2000,
      deliveryLeaseMs: 10000,
      deliveryMaxAttempts: 3
    });
  });

  it("rejects a missing database URL", () => {
    expect(() => loadEnv({})).toThrow("DATABASE_URL is required");
  });
});
