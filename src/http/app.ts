import express, { type Express } from "express";

export type HealthCheck = () => Promise<void>;

export function createApp(checkDatabase: HealthCheck): Express {
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

  return app;
}
