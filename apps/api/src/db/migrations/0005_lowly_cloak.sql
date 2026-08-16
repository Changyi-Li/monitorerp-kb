ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "issuer" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subject" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_issuer_subject_unique" ON "users" USING btree ("issuer","subject");