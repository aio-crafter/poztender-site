import { and, eq, isNull, or } from "drizzle-orm";
import { getDb } from "../db";
import { accessGrants, accessLinks, orders, type AccessGrant, type Order } from "../db/schema";
import type { BuyerDetails } from "./buyer";
import { hashAccessToken, hashSessionSecret } from "./payment-session";
import { createInvoiceId, productForPlan, type PaymentPlan } from "./robokassa";

// How long a confirmed payment entitles the customer, measured from the
// moment the payment was confirmed rather than from when a page was opened.
export const ACCESS_WINDOW_SECONDS: Record<PaymentPlan, number> = {
  pilot: 7 * 24 * 60 * 60,
  subscription: 30 * 24 * 60 * 60,
};

/**
 * Order lifecycle.
 *
 * Robokassa accepts payments from individuals only — confirmed by their
 * support — so the two buyer types never share a payment rail. An individual
 * order starts as `pending` and is settled by the Robokassa callback; a
 * business order starts as `awaiting_bank_payment` and is settled by hand once
 * a bank transfer lands. Both end at `paid`, and from there the access rules
 * are identical.
 */
export const ORDER_STATUS = {
  pending: "pending",
  awaitingBankPayment: "awaiting_bank_payment",
  paid: "paid",
} as const;

/** The status a fresh order takes, decided by who is paying. */
export function initialStatus(buyerType: string) {
  return buyerType === "business" ? ORDER_STATUS.awaitingBankPayment : ORDER_STATUS.pending;
}

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
  buyer: BuyerDetails;
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
          status: initialStatus(input.buyer.buyerType),
          sessionHash: input.sessionHash,
          buyerType: input.buyer.buyerType,
          buyerInn: input.buyer.buyerInn,
          buyerName: input.buyer.buyerName,
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
  | { outcome: "amount-mismatch" }
  | { outcome: "not-a-robokassa-order" };

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

    // A business order is never paid through Robokassa. Rejecting it here
    // stops a callback — genuine or forged — from settling an invoice that is
    // waiting on a bank transfer.
    if (order.buyerType === "business") return { outcome: "not-a-robokassa-order" };

    if (!sameAmount(order.expectedAmount, input.outSum)) {
      return { outcome: "amount-mismatch" };
    }

    const paidAt = new Date();
    const claimed = await tx
      .update(orders)
      .set({ status: ORDER_STATUS.paid, paidAt })
      // buyerType is repeated in the predicate on purpose: the Robokassa path
      // must be unable to touch a business order even if the check above is
      // ever refactored away.
      .where(
        and(
          eq(orders.id, order.id),
          eq(orders.status, ORDER_STATUS.pending),
          eq(orders.buyerType, "individual"),
        ),
      )
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
 * Resolves the browser's *selected* order: the one named by the selector
 * cookie, and only if it belongs to this browser.
 *
 * There is no ranking here on purpose. Choosing an order by status or recency
 * is a guess, and it guessed wrong as soon as a browser owned more than one:
 * a customer with an earlier paid order could not open the invoice for the one
 * they had just created. The selector says which order; this function only
 * checks that the session is entitled to it.
 *
 * Ownership is satisfied by either secret the cookie may hold — the one issued
 * at checkout, or a recovery token from an emailed link — so restoring access
 * on a second device works without evicting the first.
 *
 * The invoice number alone proves nothing: without a matching session this
 * returns null for every order in the table.
 */
export async function findSelectedOrder(
  secret: string,
  invoiceId: number,
): Promise<CheckoutState | null> {
  const db = getDb();
  const [sessionHash, linkHash] = await Promise.all([
    hashSessionSecret(secret),
    hashAccessToken(secret),
  ]);

  const [row] = await db
    .select({ order: orders, grant: accessGrants })
    .from(orders)
    .leftJoin(accessGrants, eq(accessGrants.orderId, orders.id))
    .leftJoin(accessLinks, eq(accessLinks.orderId, orders.id))
    .where(
      and(
        eq(orders.invoiceId, invoiceId),
        or(eq(orders.sessionHash, sessionHash), eq(accessLinks.tokenHash, linkHash)),
      ),
    )
    .limit(1);

  return row ? { order: row.order, grant: row.grant } : null;
}

/** The entitlement for one order, if it has one. */
export async function findGrantForOrder(orderId: number): Promise<AccessGrant | null> {
  const db = getDb();
  const [grant] = await db
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.orderId, orderId))
    .limit(1);
  return grant ?? null;
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
