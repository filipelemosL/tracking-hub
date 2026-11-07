import { spawnSync } from "node:child_process";

import { config } from "dotenv";

config({ path: ".env.test" });

const databaseUrl = process.env.DATABASE_URL_TEST;

if (!databaseUrl) {
  throw new Error("DATABASE_URL_TEST is required");
}

const databaseName = new URL(databaseUrl).pathname.slice(1);

if (databaseName !== "tracking_hub_test") {
  throw new Error("Integration tests must use the tracking_hub_test database");
}

const environment = { ...process.env, DATABASE_URL: databaseUrl };

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    env: environment,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"]);
run(process.execPath, [
  "node_modules/vitest/vitest.mjs",
  "run",
  "--config",
  "vitest.integration.config.ts"
]);
