import "dotenv/config";

export type AppEnv = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  workerPollIntervalMs: number;
  attributionWindowMinutes: number;
  trackingWaitMs: number;
  maxProcessingRetries: number;
};

function positiveInteger(name: string, rawValue: string | undefined, fallback: number): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const nodeEnv = source.NODE_ENV ?? "development";

  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new Error("NODE_ENV must be development, test or production");
  }

  if (!source.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  return {
    nodeEnv,
    port: positiveInteger("PORT", source.PORT, 3000),
    databaseUrl: source.DATABASE_URL,
    workerPollIntervalMs: positiveInteger(
      "WORKER_POLL_INTERVAL_MS",
      source.WORKER_POLL_INTERVAL_MS,
      1000
    ),
    attributionWindowMinutes: positiveInteger("ATTRIBUTION_WINDOW_MINUTES", source.ATTRIBUTION_WINDOW_MINUTES, 30),
    trackingWaitMs: positiveInteger("TRACKING_WAIT_MS", source.TRACKING_WAIT_MS, 10000),
    maxProcessingRetries: 3
  };
}
