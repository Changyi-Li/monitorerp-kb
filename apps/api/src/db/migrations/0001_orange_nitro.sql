CREATE TYPE "public"."document_status" AS ENUM('draft', 'ready', 'publishing', 'published', 'failed');--> statement-breakpoint
CREATE TABLE "document_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"from_status" "document_status",
	"to_status" "document_status" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"ext" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"ragflow_document_id" text NOT NULL,
	"chunk_method" text DEFAULT 'naive' NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"owner_id" uuid NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_ragflow_document_id_unique" UNIQUE("ragflow_document_id")
);
--> statement-breakpoint
ALTER TABLE "document_history" ADD CONSTRAINT "document_history_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_history" ADD CONSTRAINT "document_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_history_document_id_idx" ON "document_history" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_owner_id_idx" ON "documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "documents_updated_at_idx" ON "documents" USING btree ("updated_at" desc);