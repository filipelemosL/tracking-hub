import { loadEnv } from "./config/env.js";
import { createGetDatabaseDiagnostic } from "./application/diagnostics/get-database-diagnostic.js";
import { createApp } from "./http/app.js";
import {
  checkDatabaseConnection,
  prisma,
  prismaDatabaseDiagnosticRepository
} from "./infra/database/prisma.js";
import { trackingSessionRepository } from "./infra/database/tracking-session-repository.js";
import { orderWebhookRepository } from "./infra/database/order-webhook-repository.js";
import { orderSupportRepository } from "./infra/database/order-support.js";

const env = loadEnv();
const app = createApp({
  checkDatabase: checkDatabaseConnection,
  getDatabaseDiagnostic: createGetDatabaseDiagnostic(prismaDatabaseDiagnosticRepository),
  trackingSessions: trackingSessionRepository(prisma),
  orderWebhooks: orderWebhookRepository(prisma),
  getOrderTracking: orderSupportRepository(prisma),
  testScenariosEnabled: env.conversionMode === "simulated" && env.enableTestScenarios && env.nodeEnv !== "production"
});
const server = app.listen(env.port, () => {
  console.info(`tracking-hub api listening on port ${env.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.info(`received ${signal}; shutting down api`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
