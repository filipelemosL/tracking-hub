import { loadEnv } from "./config/env.js";
import { prisma } from "./infra/database/prisma.js";
import { createOrderWorker } from "./infra/database/order-worker.js";

const env = loadEnv();
const worker = createOrderWorker(prisma, env);
let running = true;
let wake: (() => void) | undefined;

async function run(): Promise<void> {
  console.info("tracking-hub worker started");
  try {
    while (running) {
      try {
        await worker.runOnce();
      } catch {
        console.error("worker cycle failed");
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.min(env.workerPollIntervalMs, 1000));
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

function shutdown(signal: string): void {
  console.info(`received ${signal}; shutting down worker`);
  running = false;
  wake?.();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

void run();
