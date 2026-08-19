ALTER TABLE "orders" ADD COLUMN "buyer_type" text DEFAULT 'individual' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_inn" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_requisites" CHECK ((
        ("orders"."buyer_type" = 'individual' AND "orders"."buyer_inn" IS NULL AND "orders"."buyer_name" IS NULL)
        OR
        ("orders"."buyer_type" = 'business' AND "orders"."buyer_inn" IS NOT NULL AND "orders"."buyer_name" IS NOT NULL)
      ));