import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/http/app.js";

describe("GET /health", () => {
  it("reports that the API and database are available", async () => {
    const checkDatabase = vi.fn().mockResolvedValue(undefined);

    const response = await request(
      createApp({
        checkDatabase,
        getDatabaseDiagnostic: vi.fn()
      })
    ).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", database: "up" });
    expect(checkDatabase).toHaveBeenCalledOnce();
  });

  it("returns 503 when the database is unavailable", async () => {
    const checkDatabase = vi.fn().mockRejectedValue(new Error("connection refused"));

    const response = await request(
      createApp({
        checkDatabase,
        getDatabaseDiagnostic: vi.fn()
      })
    ).get("/health");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "unavailable", database: "down" });
  });
});
