ALTER TYPE "DeliveryStatus" RENAME TO "DeliveryStatus_old";
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY_PENDING', 'DELIVERED', 'FAILED_PERMANENT', 'FAILED_EXHAUSTED', 'UNKNOWN', 'SKIPPED');
ALTER TABLE "conversion_deliveries" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "conversion_deliveries" ALTER COLUMN "status" TYPE "DeliveryStatus" USING (CASE "status"::text
  WHEN 'SENT' THEN 'DELIVERED'
  WHEN 'RETRY_SCHEDULED' THEN 'RETRY_PENDING'
  WHEN 'FAILED' THEN 'FAILED_PERMANENT'
  WHEN 'UNCERTAIN' THEN 'UNKNOWN'
  ELSE 'PENDING' END)::"DeliveryStatus";
ALTER TABLE "conversion_deliveries" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "DeliveryStatus_old";
CREATE TYPE "AttemptStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'UNKNOWN');

ALTER TABLE "webhook_events" ADD COLUMN "scenario" VARCHAR(64) NOT NULL DEFAULT 'SUCCESS';
ALTER TABLE "orders" ADD COLUMN "conversion_context" JSONB;
ALTER TABLE "conversion_deliveries"
  ADD COLUMN "reason" VARCHAR(64),
  ADD COLUMN "scenario" VARCHAR(64) NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN "transport_mode" VARCHAR(16) NOT NULL DEFAULT 'SIMULATED',
  ADD COLUMN "payload_schema_version" VARCHAR(32) NOT NULL DEFAULT 'demo-v1',
  ADD COLUMN "frozen_request" JSONB,
  ADD COLUMN "request_digest" CHAR(64),
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "lease_until" TIMESTAMPTZ(3);

CREATE TABLE "conversion_attempts" (
  "id" UUID NOT NULL,
  "delivery_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "started_at" TIMESTAMPTZ(3) NOT NULL,
  "finished_at" TIMESTAMPTZ(3),
  "status" "AttemptStatus" NOT NULL DEFAULT 'STARTED',
  "http_status" INTEGER,
  "error_code" VARCHAR(64),
  "response" JSONB,
  "request" JSONB NOT NULL,
  "request_digest" CHAR(64) NOT NULL,
  CONSTRAINT "conversion_attempts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "conversion_attempts_delivery_id_attempt_number_key" ON "conversion_attempts"("delivery_id", "attempt_number");
ALTER TABLE "conversion_attempts" ADD CONSTRAINT "conversion_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "conversion_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "conversion_deliveries_status_next_attempt_at_idx" ON "conversion_deliveries"("status", "next_attempt_at");
CREATE INDEX "conversion_deliveries_status_lease_until_idx" ON "conversion_deliveries"("status", "lease_until");
