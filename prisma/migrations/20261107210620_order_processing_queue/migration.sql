-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('PENDING', 'WAITING_TRACKING', 'PROCESSED', 'CONFLICT', 'FAILED');

-- CreateEnum
CREATE TYPE "AttributionStatus" AS ENUM ('ATTRIBUTED', 'UNATTRIBUTED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'RETRY_SCHEDULED', 'FAILED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "ConversionProvider" AS ENUM ('META', 'GOOGLE', 'TIKTOK', 'UTMIFY', 'REDTRACK');

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "event_id" VARCHAR(128) NOT NULL,
    "event" VARCHAR(32) NOT NULL,
    "order_id" VARCHAR(128) NOT NULL,
    "original_payload" JSONB NOT NULL,
    "normalized_payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(64),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurred_at" TIMESTAMPTZ(3),
    "tracking_deadline" TIMESTAMPTZ(3),
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(128),
    "order_db_id" UUID,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_id" VARCHAR(128) NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "time_source" VARCHAR(16) NOT NULL,
    "attribution_status" "AttributionStatus" NOT NULL,
    "tracking_session_id" UUID,
    "attribution" JSONB NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversion_deliveries" (
    "id" UUID NOT NULL,
    "order_db_id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "provider" "ConversionProvider" NOT NULL,
    "conversion_id" CHAR(64) NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "next_attempt_at" TIMESTAMPTZ(3),

    CONSTRAINT "conversion_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_event_id_key" ON "webhook_events"("event_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_next_attempt_at_idx" ON "webhook_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_events_order_id_received_at_idx" ON "webhook_events"("order_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_id_key" ON "orders"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_deliveries_conversion_id_key" ON "conversion_deliveries"("conversion_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_deliveries_order_db_id_type_provider_key" ON "conversion_deliveries"("order_db_id", "type", "provider");

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_order_db_id_fkey" FOREIGN KEY ("order_db_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tracking_session_id_fkey" FOREIGN KEY ("tracking_session_id") REFERENCES "tracking_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversion_deliveries" ADD CONSTRAINT "conversion_deliveries_order_db_id_fkey" FOREIGN KEY ("order_db_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
