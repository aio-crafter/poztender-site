import { sql } from "drizzle-orm";
import {
  bigint,
  check,
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
    // 'individual' | 'business'. A business buyer is an organisation or a sole
    // trader, and a receipt issued to one has to name the buyer and its INN.
    buyerType: text("buyer_type").notNull().default("individual"),
    buyerInn: text("buyer_inn"),
    buyerName: text("buyer_name"),
    // 'pending' | 'paid'. There is no 'failed' state: Robokassa simply never
    // sends a ResultURL for an abandoned payment, so an unpaid order stays
    // pending and is meaningless rather than wrong.
    status: text("status").notNull().default("pending"),
    // How the payment was confirmed: 'robokassa' for the automated callback,
    // 'bank_transfer' for a manual confirmation. Distinguishes automated from
    // human-confirmed money without recording who the operator was.
    paymentConfirmationSource: text("payment_confirmation_source"),
    // SHA-256 of the checkout cookie secret. The plaintext lives only in the
    // customer's browser, so a database leak cannot be replayed as a session.
    sessionHash: text("session_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (table) => [
    index("orders_session_hash_idx").on(table.sessionHash),
    // The pairing is enforced by the database, not only by the validator: a
    // business order without requisites cannot exist, and an individual order
    // cannot carry stray tax details.
    check(
      "orders_buyer_requisites",
      sql`(
        (${table.buyerType} = 'individual' AND ${table.buyerInn} IS NULL AND ${table.buyerName} IS NULL)
        OR
        (${table.buyerType} = 'business' AND ${table.buyerInn} IS NOT NULL AND ${table.buyerName} IS NOT NULL)
      )`,
    ),
  ],
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

/**
 * A recovery link for an order that has already been paid for.
 *
 * It carries no rights of its own: redeeming it only re-establishes the
 * checkout cookie for an order whose `status` is already 'paid', and every page
 * still consults `access_grants` afterwards. That is what makes it safe to
 * email, and safe to open more than once.
 *
 * `orderId` is UNIQUE so a resend reuses the same row instead of accumulating
 * links, and only the SHA-256 of the token is stored — the token itself exists
 * only in the customer's email.
 */
export const accessLinks = pgTable("access_links", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .unique()
    .references(() => orders.id),
  tokenHash: text("token_hash").notNull().unique(),
  // Aligned with the grant's validUntil: the link dies exactly when access does.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export type Order = typeof orders.$inferSelect;
export type AccessLink = typeof accessLinks.$inferSelect;
export type AccessGrant = typeof accessGrants.$inferSelect;
