ALTER TABLE "document_history" ALTER COLUMN "from_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "document_history" ALTER COLUMN "to_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "status" SET DEFAULT 'draft'::text;--> statement-breakpoint
DROP TYPE "public"."document_status";--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('draft', 'publishing', 'published', 'failed');--> statement-breakpoint
-- Amendment (issue #19): 'ready' is removed from the lifecycle. The columns
-- are still text here — rewrite legacy data before the casts below, which
-- would fail on a 'ready' value that the new enum no longer admits.
UPDATE "documents" SET "status" = 'draft' WHERE "status" = 'ready';--> statement-breakpoint
-- Collapse each draft→ready + ready→publishing pair into a single
-- draft→publishing leg: rewrite the publishing leg's from_status, then drop
-- the legs that ended in 'ready'. History keeps one row per transition.
-- Unpaired legs (marked ready, never published) are dropped too — the
-- amendment's decision is a scrubbed, uniformly four-status vocabulary.
UPDATE "document_history" SET "from_status" = 'draft' WHERE "from_status" = 'ready';--> statement-breakpoint
DELETE FROM "document_history" WHERE "to_status" = 'ready';--> statement-breakpoint
ALTER TABLE "document_history" ALTER COLUMN "from_status" SET DATA TYPE "public"."document_status" USING "from_status"::"public"."document_status";--> statement-breakpoint
ALTER TABLE "document_history" ALTER COLUMN "to_status" SET DATA TYPE "public"."document_status" USING "to_status"::"public"."document_status";--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "status" SET DEFAULT 'draft'::"public"."document_status";--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "status" SET DATA TYPE "public"."document_status" USING "status"::"public"."document_status";