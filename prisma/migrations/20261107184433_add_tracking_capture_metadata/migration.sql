-- AlterTable
ALTER TABLE "tracking_sessions" ADD COLUMN     "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "visitor_id" VARCHAR(128),
ALTER COLUMN "captured_at" DROP NOT NULL,
ALTER COLUMN "captured_at" DROP DEFAULT;

-- Older captures had a server-generated captured_at. Preserve that observation
-- as received_at without presenting it as a client-supplied timestamp.
UPDATE "tracking_sessions" SET "received_at" = "captured_at", "captured_at" = NULL;
