import express, { type Express } from "express";

import type { GetDatabaseDiagnostic } from "../application/diagnostics/get-database-diagnostic.js";

export type HealthCheck = () => Promise<void>;

export type AppDependencies = {
  checkDatabase: HealthCheck;
  getDatabaseDiagnostic: GetDatabaseDiagnostic;
};

export function createApp({ checkDatabase, getDatabaseDiagnostic }: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_request, response) => {
    try {
      await checkDatabase();
      response.status(200).json({ status: "ok", database: "up" });
    } catch {
      response.status(503).json({ status: "unavailable", database: "down" });
    }
  });

  app.get("/diagnostics/database", async (_request, response) => {
    try {
      const diagnostic = await getDatabaseDiagnostic();
      response.status(200).json({ status: "ok", database: diagnostic });
    } catch {
      response.status(503).json({
        status: "unavailable",
        database: { status: "down" }
      });
    }
  });

  return app;
}
