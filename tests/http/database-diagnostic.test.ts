import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/http/app.js";

describe("GET /diagnostics/database", () => {
  it("returns a diagnostic produced from database data", async () => {
    const getDatabaseDiagnostic = vi.fn().mockResolvedValue({
      status: "up",
      trackingSessions: 3
    });

    const response = await request(
      createApp({
        checkDatabase: vi.fn(),
        getDatabaseDiagnostic
      })
    ).get("/diagnostics/database");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      database: { status: "up", trackingSessions: 3 }
    });
    expect(getDatabaseDiagnostic).toHaveBeenCalledOnce();
  });

  it("does not expose internal errors when the database is unavailable", async () => {
    const getDatabaseDiagnostic = vi
      .fn()
      .mockRejectedValue(new Error("postgresql://user:secret@db/internal"));

    const response = await request(
      createApp({
        checkDatabase: vi.fn(),
        getDatabaseDiagnostic
      })
    ).get("/diagnostics/database");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "unavailable",
      database: { status: "down" }
    });
    expect(response.text).not.toContain("secret");
  });
});
