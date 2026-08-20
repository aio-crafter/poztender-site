CREATE TABLE "access_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	CONSTRAINT "access_links_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "access_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_confirmation_source" text;--> statement-breakpoint
ALTER TABLE "access_links" ADD CONSTRAINT "access_links_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;