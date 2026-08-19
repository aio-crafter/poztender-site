import {
  bigint,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * A checkout attempt. One row is created before the customer leaves for
 * Robokassa, and it is the only place the price is decided.
 *
 * `invoiceId` carries a UNIQUE constraint because it is the idempotency anchor
 * for the whole payment flow: Robokassa identifies an operation by it, and the
 * database — not application logic — is what guarantees that two concurrent
 * ResultURL deliveries cannot produce two paid orders.
 */
export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    // Robokassa documents InvId as int64. The value is random rather than
    // sequential so that order numbers cannot be enumerated.
    invoiceId: bigint("invoice_id", { mode: "number" }).notNull().unique(),
    plan: text("plan").notNull(),
    // The price the server committed to at checkout time. The ResultURL
    // handler compares the amount Robokassa reports against this column and
    // never against anything supplied by the browser.
    expectedAmount: numeric("expected_amount", { precision: 12, scale: 2 }).notNull(),
    email: text("email").notNull(),
    // 'pending' | 'paid'. There is no 'failed' state: Robokassa simply never
    // sends a ResultURL for an abandoned payment, so an unpaid order stays
    // pending and is meaningless rather than wrong.
    status: text("status").notNull().default("pending"),
    // SHA-256 of the checkout cookie secret. The plaintext lives only in the
    // customer's browser, so a database leak cannot be replayed as a session.
    sessionHash: text("session_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (table) => [index("orders_session_hash_idx").on(table.sessionHash)],
);

/**
 * The entitlement earned by a paid order. Created only inside the ResultURL
 * transaction, never from a page the customer can open.
 *
 * `orderId` is UNIQUE, which is what makes "one paid order grants access
 * exactly once" a property of the data rather than of the code path that
 * happens to run.
 */
export const accessGrants = pgTable("access_grants", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .unique()
    .references(() => orders.id),
  // Both derived from the confirmed payment time, not from when the customer
  // opens a page, so the access window cannot be extended by revisiting a URL.
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
  // Set when the intake form is submitted; replaces the in-memory map that
  // used to lose its contents on every container restart.
  usedAt: timestamp("used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export type Order = typeof orders.$inferSelect;
export type AccessGrant = typeof accessGrants.$inferSelect;
