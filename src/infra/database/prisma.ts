import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export async function checkDatabaseConnection(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
