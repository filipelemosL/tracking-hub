-- CreateTable
CREATE TABLE "tracking_sessions" (
    "id" UUID NOT NULL,
    "session_id" VARCHAR(128) NOT NULL,
    "page_url" TEXT NOT NULL,
    "custom_fields" JSONB NOT NULL,
    "fbclid" VARCHAR(512),
    "fbc" VARCHAR(512),
    "fbp" VARCHAR(512),
    "gclid" VARCHAR(512),
    "gbraid" VARCHAR(512),
    "wbraid" VARCHAR(512),
    "ttclid" VARCHAR(512),
    "ttp" VARCHAR(512),
    "redtrack_click_id" VARCHAR(512),
    "utmify_id" VARCHAR(512),
    "customer_email_hash" CHAR(64),
    "customer_phone_hash" CHAR(64),
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracking_sessions_session_id_key" ON "tracking_sessions"("session_id");

-- CreateIndex
CREATE INDEX "tracking_sessions_fbclid_idx" ON "tracking_sessions"("fbclid");

-- CreateIndex
CREATE INDEX "tracking_sessions_fbc_idx" ON "tracking_sessions"("fbc");

-- CreateIndex
CREATE INDEX "tracking_sessions_gclid_idx" ON "tracking_sessions"("gclid");

-- CreateIndex
CREATE INDEX "tracking_sessions_gbraid_idx" ON "tracking_sessions"("gbraid");

-- CreateIndex
CREATE INDEX "tracking_sessions_wbraid_idx" ON "tracking_sessions"("wbraid");

-- CreateIndex
CREATE INDEX "tracking_sessions_ttclid_idx" ON "tracking_sessions"("ttclid");

-- CreateIndex
CREATE INDEX "tracking_sessions_redtrack_click_id_idx" ON "tracking_sessions"("redtrack_click_id");

-- CreateIndex
CREATE INDEX "tracking_sessions_utmify_id_idx" ON "tracking_sessions"("utmify_id");

-- CreateIndex
CREATE INDEX "tracking_sessions_customer_email_hash_captured_at_idx" ON "tracking_sessions"("customer_email_hash", "captured_at");

-- CreateIndex
CREATE INDEX "tracking_sessions_customer_phone_hash_captured_at_idx" ON "tracking_sessions"("customer_phone_hash", "captured_at");
