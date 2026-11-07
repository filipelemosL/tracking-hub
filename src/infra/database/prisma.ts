import { PrismaClient } from "@prisma/client";

import type { DatabaseDiagnosticRepository } from "../../application/diagnostics/get-database-diagnostic.js";

export const prisma = new PrismaClient();

export async function checkDatabaseConnection(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export const prismaDatabaseDiagnosticRepository: DatabaseDiagnosticRepository = {
  async countTrackingSessions(): Promise<number> {
    return prisma.trackingSession.count();
  }
};
