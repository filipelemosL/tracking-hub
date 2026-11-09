import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/http/app.js";

afterEach(() => vi.restoreAllMocks());

describe("HTTP console logs", () => {
  it("logs every request and response with the same ID while hiding contact data and credentials", async () => {
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const app = createApp({
      checkDatabase: async () => {},
      getDatabaseDiagnostic: async () => ({ status: "up", trackingSessions: 0 }),
      orderWebhooks: { findByEventId: async () => null, create: async () => {} }
    });
    const accepted = await request(app).post("/webhooks/orders?token=query-secret")
      .set("Authorization", "Bearer header-secret")
      .send({ eventId: "event-1", event: "ORDER_PAID", orderId: "order-1", amount: 25500, currency: "USD",
        customer: { email: "buyer@example.test", phone: "+15550100123" }, customFields: { campaign: "launch", apiKey: "field-secret" } });
    expect(accepted.status).toBe(202);
    const lines = logged.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[tracking-hub] "));
    const entries = lines.map((line) => JSON.parse(line.slice("[tracking-hub] ".length)) as { kind: string; details: Record<string, unknown> });
    expect(entries.map((entry) => entry.kind)).toEqual(["http.request", "http.response"]);
    const inbound = entries[0]!.details as { requestId: string; body: { customer: { email: string; phone: string }; customFields: { campaign: string; apiKey: string } }; headers: { authorization: string }; query: { token: string } };
    const outbound = entries[1]!.details as { requestId: string; status: number; body: { eventId: string } };
    expect(inbound.requestId).toBe(outbound.requestId);
    expect(inbound.body.customer).toEqual({ email: "[REDACTED]", phone: "[REDACTED]" });
    expect(inbound.body.customFields).toEqual({ campaign: "launch", apiKey: "[REDACTED]" });
    expect(inbound.headers.authorization).toBe("[REDACTED]");
    expect(inbound.query.token).toBe("[REDACTED]");
    expect(outbound).toMatchObject({ status: 202, body: { eventId: "event-1" } });
    expect(lines.join("\n")).not.toMatch(/buyer@example\.test|15550100123|header-secret|query-secret|field-secret/);
  });

  it("also logs malformed JSON responses without exposing the invalid body", async () => {
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const app = createApp({ checkDatabase: async () => {}, getDatabaseDiagnostic: async () => ({ status: "up", trackingSessions: 0 }) });
    const response = await request(app).post("/tracking/sessions").set("Content-Type", "application/json").send("{");
    expect(response.status).toBe(400);
    const lines = logged.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[tracking-hub] "));
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).toContain("http.response");
    expect(lines.join("\n")).toContain("VALIDATION_ERROR");
  });
});
