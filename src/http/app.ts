import express, { type Express } from "express";

import type { GetDatabaseDiagnostic } from "../application/diagnostics/get-database-diagnostic.js";
import { captureSession, CaptureConflictError, type CaptureRepository } from "../application/tracking/capture-session.js";
import { CaptureValidationError, validateTrackingSession } from "./validate-tracking-session.js";
import { receiveOrderWebhook, WebhookConflictError, type WebhookRepository } from "../application/orders/order-webhook.js";
import { OrderWebhookValidationError, validateOrderWebhook } from "./validate-order-webhook.js";
import { scenarios, type ConversionScenario } from "../application/conversions/providers.js";

export type HealthCheck = () => Promise<void>;

export type AppDependencies = {
  checkDatabase: HealthCheck;
  getDatabaseDiagnostic: GetDatabaseDiagnostic;
  trackingSessions?: CaptureRepository;
  orderWebhooks?: WebhookRepository;
  getOrderTracking?: (orderId: string) => Promise<{ status: number; body: unknown }>;
  now?: () => Date;
  testScenariosEnabled?: boolean;
};

export function createApp({ checkDatabase, getDatabaseDiagnostic, trackingSessions, orderWebhooks, getOrderTracking, now = () => new Date(), testScenariosEnabled = false }: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  if (trackingSessions) app.post("/tracking/sessions", async (request, response) => {
    const receivedAt = now();
    try {
      const input = validateTrackingSession(request.body, receivedAt);
      const result = await captureSession(trackingSessions, input, receivedAt);
      response.status(result.created ? 201 : 200).json({
        sessionId: result.capture.sessionId,
        created: result.created,
        capturedAt: result.capture.capturedAt?.toISOString() ?? null,
        receivedAt: result.capture.receivedAt.toISOString()
      });
    } catch (error) {
      if (error instanceof CaptureValidationError) {
        response.status(400).json({ code: "VALIDATION_ERROR", fields: error.fields });
      } else if (error instanceof CaptureConflictError) {
        response.status(409).json({ code: "SESSION_CAPTURE_CONFLICT" });
      } else {
        response.status(500).json({ code: "INTERNAL_ERROR" });
      }
    }
  });

  if (orderWebhooks) app.post("/webhooks/orders", async (request, response) => {
    const receivedAt = now();
    try {
      const scenarioHeader = request.header("X-Test-Conversion-Scenario");
      if (scenarioHeader !== undefined && !testScenariosEnabled) {
        response.status(400).json({ code: "TEST_SCENARIO_DISABLED" }); return;
      }
      if (scenarioHeader !== undefined && !scenarios.includes(scenarioHeader as ConversionScenario)) {
        response.status(400).json({ code: "INVALID_TEST_SCENARIO" }); return;
      }
      const input = validateOrderWebhook(request.body, receivedAt);
      const { duplicate } = await receiveOrderWebhook(orderWebhooks, input, request.body, receivedAt, (scenarioHeader ?? "SUCCESS") as ConversionScenario, scenarioHeader !== undefined);
      response.status(202).json({ eventId: input.eventId, accepted: true, duplicate });
    } catch (error) {
      if (error instanceof OrderWebhookValidationError) {
        response.status(400).json({ code: "VALIDATION_ERROR", fields: error.fields });
      } else if (error instanceof WebhookConflictError) {
        response.status(409).json({ code: "WEBHOOK_EVENT_CONFLICT" });
      } else {
        response.status(503).json({ code: "WEBHOOK_PERSISTENCE_FAILED" });
      }
    }
  });

  if (getOrderTracking) app.get("/support/orders/:orderId/tracking", async (request, response) => {
    try {
      const result = await getOrderTracking(request.params.orderId as string);
      response.status(result.status).json(result.body);
    } catch {
      response.status(503).json({ code: "SUPPORT_LOOKUP_FAILED" });
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ code: "VALIDATION_ERROR", fields: ["body"] });
    } else if (error instanceof Error && "status" in error && error.status === 413) {
      response.status(413).json({ code: "BODY_TOO_LARGE", fields: ["body"] });
    } else {
      next(error);
    }
  });

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
