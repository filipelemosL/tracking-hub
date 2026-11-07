import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createGetDatabaseDiagnostic } from "../../src/application/diagnostics/get-database-diagnostic.js";
import { createApp } from "../../src/http/app.js";
import { trackingSessionRepository } from "../../src/infra/database/tracking-session-repository.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl || new URL(databaseUrl).pathname.slice(1) !== "tracking_hub_test") {
  throw new Error("HTTP integration tests require tracking_hub_test");
}
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const now = new Date("2026-11-07T17:00:00.000Z");
const app = createApp({
  checkDatabase: async () => {},
  getDatabaseDiagnostic: createGetDatabaseDiagnostic({ countTrackingSessions: () => prisma.trackingSession.count() }),
  trackingSessions: trackingSessionRepository(prisma),
  now: () => now
});
const capture = {
  sessionId: "session_123",
  visitorId: "visitor_456",
  capturedAt: "2026-11-07T16:58:00.000Z",
  pageUrl: "https://checkout.example.test/product",
  customFields: { source: "facebook", campaign: "sale", affiliateCode: "AFF-001" },
  identifiers: { fbclid: "fb-click-id", gclid: "google-click-id", gbraid: null },
  customer: { email: "Customer@Example.test", phone: "+1 (415) 555-0123" }
};

describe("POST /tracking/sessions", () => {
  beforeEach(async () => { await prisma.trackingSession.deleteMany(); });
  afterAll(async () => { await prisma.trackingSession.deleteMany(); await prisma.$disconnect(); });

  it("persists all capture evidence and distinguishes client time from receipt time", async () => {
    const response = await request(app).post("/tracking/sessions").send(capture);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ sessionId: "session_123", created: true,
      capturedAt: capture.capturedAt, receivedAt: now.toISOString() });
    const row = await prisma.trackingSession.findUniqueOrThrow({ where: { sessionId: capture.sessionId } });
    expect(row).toMatchObject({ visitorId: capture.visitorId, pageUrl: capture.pageUrl,
      customFields: capture.customFields, fbclid: "fb-click-id", gclid: "google-click-id", gbraid: null });
    expect(row.customerEmailHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.customerPhoneHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(response.body)).not.toContain("Customer@Example.test");
  });

  it("accepts the original payload without visitor or client capture time", async () => {
    const { visitorId, capturedAt, ...original } = capture;
    const response = await request(app).post("/tracking/sessions").send(original);
    expect(response.status).toBe(201);
    expect(response.body.capturedAt).toBeNull();
    const row = await prisma.trackingSession.findUniqueOrThrow({ where: { sessionId: capture.sessionId } });
    expect(row.visitorId).toBeNull();
    expect(row.capturedAt).toBeNull();
  });

  it("keeps missing campaign data absent and partial identifiers available for a later sale", async () => {
    const payload = { sessionId: "partial", pageUrl: capture.pageUrl, identifiers: { fbclid: "  click-id  ", ttclid: "  " } };
    expect((await request(app).post("/tracking/sessions").send(payload)).status).toBe(201);
    const row = await prisma.trackingSession.findUniqueOrThrow({ where: { sessionId: "partial" } });
    expect(row.customFields).toEqual({});
    expect(row.fbclid).toBe("  click-id  ");
    expect(row.ttclid).toBeNull();
    expect(row.gclid).toBeNull();
  });

  it("replays the same immutable capture without updating its original timestamps", async () => {
    const first = await request(app).post("/tracking/sessions").send(capture);
    const firstRow = await prisma.trackingSession.findUniqueOrThrow({ where: { sessionId: capture.sessionId } });
    const second = await request(app).post("/tracking/sessions").send(capture);
    const secondRow = await prisma.trackingSession.findUniqueOrThrow({ where: { sessionId: capture.sessionId } });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body).toEqual({ ...first.body, created: false });
    expect(secondRow).toEqual(firstRow);
    expect(await prisma.trackingSession.count()).toBe(1);
  });

  it("recognizes reordered customFields and unavailable identifier representations as equivalent", async () => {
    await request(app).post("/tracking/sessions").send(capture);
    const reordered = { ...capture,
      customFields: { affiliateCode: "AFF-001", campaign: "sale", source: "facebook" },
      identifiers: { gbraid: " ", gclid: "google-click-id", fbclid: "fb-click-id", wbraid: null } };
    expect((await request(app).post("/tracking/sessions").send(reordered)).status).toBe(200);
  });

  it("rejects a changed affiliate while preserving the original evidence", async () => {
    await request(app).post("/tracking/sessions").send(capture);
    const changed = { ...capture, customFields: { ...capture.customFields, affiliateCode: "AFF-OTHER" } };
    const response = await request(app).post("/tracking/sessions").send(changed);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ code: "SESSION_CAPTURE_CONFLICT" });
    expect((await prisma.trackingSession.findUniqueOrThrow({ where: { sessionId: capture.sessionId } })).customFields)
      .toEqual(capture.customFields);
  });

  it("resolves concurrent identical inserts as one creation and one replay", async () => {
    const responses = await Promise.all(Array.from({ length: 2 }, () => request(app).post("/tracking/sessions").send(capture)));
    expect(responses.map((item) => item.status).sort()).toEqual([200, 201]);
    expect(await prisma.trackingSession.count()).toBe(1);
  });

  it("resolves concurrent different affiliates as one creation and one conflict", async () => {
    const changed = { ...capture, customFields: { ...capture.customFields, affiliateCode: "AFF-OTHER" } };
    const responses = await Promise.all([capture, changed].map((body) => request(app).post("/tracking/sessions").send(body)));
    expect(responses.map((item) => item.status).sort()).toEqual([201, 409]);
    expect(await prisma.trackingSession.count()).toBe(1);
  });

  it.each([
    [{ ...capture, sessionId: " " }, "sessionId"],
    [{ ...capture, pageUrl: "ftp://example.test" }, "pageUrl"],
    [{ ...capture, capturedAt: "2026-11-07" }, "capturedAt"],
    [{ ...capture, capturedAt: "2026-02-30T10:00:00Z" }, "capturedAt"],
    [{ ...capture, customer: { email: "invalid" } }, "customer.email"]
  ])("returns field errors without personal data", async (payload, field) => {
    const response = await request(app).post("/tracking/sessions").send(payload);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ code: "VALIDATION_ERROR", fields: [field] });
  });

  it("accepts a client timestamp within five minutes and rejects one beyond", async () => {
    const inside = await request(app).post("/tracking/sessions").send({ ...capture, capturedAt: "2026-11-07T17:05:00.000Z" });
    expect(inside.status).toBe(201);
    const outside = await request(app).post("/tracking/sessions").send({ ...capture,
      sessionId: "future", capturedAt: "2026-11-07T17:05:00.001Z" });
    expect(outside.status).toBe(400);
    expect(outside.body.fields).toContain("capturedAt");
  });
});
