import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { accessGrants, orders, type AccessGrant, type Order } from "../db/schema";
import { createInvoiceId, productForPlan, type PaymentPlan } from "./robokassa";

// How long a confirmed payment entitles the customer, measured from the
// moment the payment was confirmed rather than from when a page was opened.
const ACCESS_WINDOW_SECONDS: Record<PaymentPlan, number> = {
  pilot: 7 * 24 * 60 * 60,
  subscription: 30 * 24 * 60 * 60,
};

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/**
 * `numeric` comes back from PostgreSQL as a string, and Robokassa reports the
 * amount with two decimals in test mode and six in live mode, so the two are
 * only ever comparable as numbers.
 */
function sameAmount(expected: string, received: string) {
  return Number(expected) === Number(received);
}

export async function createPendingOrder(input: {
  plan: PaymentPlan;
  email: string;
  sessionHash: string;
}): Promise<Order> {
  const db = getDb();
  const product = productForPlan(input.plan);

  // A random InvId can collide in principle; the UNIQUE constraint is what
  // decides, and a fresh number is drawn if it does.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const [order] = await db
        .insert(orders)
        .values({
          invoiceId: Number(createInvoiceId()),
          plan: input.plan,
          expectedAmount: product.amount,
          email: input.email,
          status: "pending",
          sessionHash: input.sessionHash,
        })
        .returning();
      return order;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  throw new Error("Could not allocate a unique invoice id");
}

export type ConfirmationOutcome =
  | { outcome: "confirmed"; order: Order }
  | { outcome: "already-paid"; order: Order }
  | { outcome: "unknown-order" }
  | { outcome: "amount-mismatch" };

/**
 * The authoritative payment transition, called only from the ResultURL
 * handler.
 *
 * Concurrency is handled by the conditional UPDATE rather than by the earlier
 * SELECT: two simultaneous deliveries both read a pending row, but the second
 * UPDATE blocks on the first one's lock and then re-evaluates
 * `status = 'pending'` against the committed row, so it matches nothing.
 * Exactly one caller sees a row back and creates the grant.
 */
export async function confirmPayment(input: {
  invoiceId: number;
  outSum: string;
}): Promise<ConfirmationOutcome> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.invoiceId, input.invoiceId))
      .limit(1);

    if (!order) return { outcome: "unknown-order" };
    if (!sameAmount(order.expectedAmount, input.outSum)) {
      return { outcome: "amount-mismatch" };
    }

    const paidAt = new Date();
    const claimed = await tx
      .update(orders)
      .set({ status: "paid", paidAt })
      .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
      .returning();

    if (claimed.length === 0) {
      // Someone already moved this order to paid: a retry from Robokassa, or
      // the other half of a concurrent pair. paidAt keeps its original value.
      return { outcome: "already-paid", order };
    }

    const plan: PaymentPlan = order.plan === "subscription" ? "subscription" : "pilot";
    await tx
      .insert(accessGrants)
      .values({
        orderId: order.id,
        validFrom: paidAt,
        validUntil: new Date(paidAt.getTime() + ACCESS_WINDOW_SECONDS[plan] * 1000),
      })
      // Redundant next to the conditional UPDATE above, and kept anyway: the
      // UNIQUE constraint on order_id is the last line of defence that makes
      // "one order, one grant" true no matter how the code above evolves.
      .onConflictDoNothing({ target: accessGrants.orderId });

    return { outcome: "confirmed", order: claimed[0] };
  });
}

export interface CheckoutState {
  order: Order;
  grant: AccessGrant | null;
}

/**
 * Resolves the browser's checkout cookie to its order.
 *
 * One browser can own several orders — going back and starting checkout again
 * makes another one — so a paid order is preferred over a pending one, and the
 * newest wins within each group. Without that ordering, someone who restarted
 * checkout and then completed the *first* payment would be shown "processing"
 * forever while their paid order sat one row away.
 */
export async function findOrderBySessionHash(sessionHash: string): Promise<CheckoutState | null> {
  const db = getDb();
  const [row] = await db
    .select({ order: orders, grant: accessGrants })
    .from(orders)
    .leftJoin(accessGrants, eq(accessGrants.orderId, orders.id))
    .where(eq(orders.sessionHash, sessionHash))
    .orderBy(sql`CASE WHEN ${orders.status} = 'paid' THEN 0 ELSE 1 END`, desc(orders.id))
    .limit(1);

  return row ? { order: row.order, grant: row.grant } : null;
}

export function isGrantActive(grant: AccessGrant | null, order: Order, now = new Date()) {
  return Boolean(
    grant &&
      order.status === "paid" &&
      !grant.revokedAt &&
      grant.validFrom <= now &&
      grant.validUntil > now,
  );
}

/**
 * Marks the entitlement as spent. The `used_at IS NULL` predicate makes this
 * safe to call twice: the second caller gets no row back and is told the
 * intake was already submitted.
 */
export async function claimGrant(grantId: number) {
  const db = getDb();
  const claimed = await db
    .update(accessGrants)
    .set({ usedAt: new Date() })
    .where(and(eq(accessGrants.id, grantId), isNull(accessGrants.usedAt)))
    .returning({ id: accessGrants.id });

  return claimed.length > 0;
}
