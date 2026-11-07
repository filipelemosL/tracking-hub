import { loadEnv } from "./config/env.js";
import { checkDatabaseConnection, prisma } from "./infra/database/prisma.js";

const env = loadEnv();
let running = true;

async function run(): Promise<void> {
  console.info("tracking-hub worker started");

  while (running) {
    try {
      await checkDatabaseConnection();
    } catch {
      console.error("worker could not reach the database");
    }

    await new Promise((resolve) => setTimeout(resolve, env.workerPollIntervalMs));
  }
}

async function shutdown(signal: string): Promise<void> {
  console.info(`received ${signal}; shutting down worker`);
  running = false;
  await prisma.$disconnect();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void run();
