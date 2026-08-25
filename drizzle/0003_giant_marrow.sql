CREATE TABLE "intake_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"grant_id" integer NOT NULL,
	"company" text NOT NULL,
	"inn" text NOT NULL,
	"contact_name" text NOT NULL,
	"email" text NOT NULL,
	"telegram" text DEFAULT '' NOT NULL,
	"reply_channel" text NOT NULL,
	"regions" text NOT NULL,
	"work_types" text NOT NULL,
	"budget" text DEFAULT '' NOT NULL,
	"licenses" text DEFAULT '' NOT NULL,
	"exclusions" text DEFAULT '' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"telegram_notified_at" timestamp with time zone,
	"email_notified_at" timestamp with time zone,
	CONSTRAINT "intake_submissions_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "intake_submissions_grant_id_unique" UNIQUE("grant_id"),
	CONSTRAINT "intake_submissions_reply_channel" CHECK ("intake_submissions"."reply_channel" IN ('telegram', 'email'))
);
--> statement-breakpoint
ALTER TABLE "intake_submissions" ADD CONSTRAINT "intake_submissions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_submissions" ADD CONSTRAINT "intake_submissions_grant_id_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grants"("id") ON DELETE no action ON UPDATE no action;