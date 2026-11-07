import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL_TEST;

if (!databaseUrl) {
  throw new Error("DATABASE_URL_TEST is required");
}

if (new URL(databaseUrl).pathname.slice(1) !== "tracking_hub_test") {
  throw new Error("Refusing to run integration tests outside tracking_hub_test");
}

const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } }
});

describe("TrackingSession persistence", () => {
  beforeAll(async () => {
    await prisma.trackingSession.deleteMany();
  });

  afterAll(async () => {
    await prisma.trackingSession.deleteMany();
    await prisma.$disconnect();
  });

  it("writes and reads a tracking session in the test database", async () => {
    const created = await prisma.trackingSession.create({
      data: {
        sessionId: "session_test_001",
        pageUrl: "https://checkout.example.test/product",
        customFields: {
          source: "facebook",
          campaign: "test-campaign",
          affiliateCode: "TEST-AFFILIATE"
        },
        fbclid: "test-fb-click-id",
        fbc: "test-meta-fbc",
        fbp: "test-meta-fbp",
        customerEmailHash: "a".repeat(64)
      }
    });

    const reloaded = await prisma.trackingSession.findUnique({
      where: { sessionId: created.sessionId }
    });

    expect(reloaded).toMatchObject({
      id: created.id,
      sessionId: "session_test_001",
      pageUrl: "https://checkout.example.test/product",
      customFields: {
        source: "facebook",
        campaign: "test-campaign",
        affiliateCode: "TEST-AFFILIATE"
      },
      fbclid: "test-fb-click-id",
      fbc: "test-meta-fbc",
      fbp: "test-meta-fbp",
      customerEmailHash: "a".repeat(64)
    });
    expect(reloaded?.capturedAt).toBeNull();
    expect(reloaded?.receivedAt).toBeInstanceOf(Date);
  });
});
