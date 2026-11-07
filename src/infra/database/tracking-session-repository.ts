import { Prisma, PrismaClient, type TrackingSession } from "@prisma/client";

import type { CaptureInput, CaptureRepository, StoredCapture } from "../../application/tracking/capture-session.js";

function toCapture(row: TrackingSession): StoredCapture {
  return {
    sessionId: row.sessionId,
    visitorId: row.visitorId,
    capturedAt: row.capturedAt,
    receivedAt: row.receivedAt,
    pageUrl: row.pageUrl,
    customFields: row.customFields as Record<string, unknown>,
    identifiers: {
      fbclid: row.fbclid, fbc: row.fbc, fbp: row.fbp,
      gclid: row.gclid, gbraid: row.gbraid, wbraid: row.wbraid,
      ttclid: row.ttclid, ttp: row.ttp,
      redtrackClickId: row.redtrackClickId, utmifyId: row.utmifyId
    },
    customerEmailHash: row.customerEmailHash,
    customerPhoneHash: row.customerPhoneHash
  };
}

export function trackingSessionRepository(prisma: PrismaClient): CaptureRepository {
  return {
    async findBySessionId(sessionId) {
      const row = await prisma.trackingSession.findUnique({ where: { sessionId } });
      return row ? toCapture(row) : null;
    },
    async create(input: CaptureInput, receivedAt: Date) {
      const row = await prisma.trackingSession.create({
        data: {
          sessionId: input.sessionId,
          visitorId: input.visitorId,
          capturedAt: input.capturedAt,
          receivedAt,
          pageUrl: input.pageUrl,
          customFields: input.customFields as Prisma.InputJsonObject,
          ...input.identifiers,
          customerEmailHash: input.customerEmailHash,
          customerPhoneHash: input.customerPhoneHash
        }
      });
      return toCapture(row);
    }
  };
}
