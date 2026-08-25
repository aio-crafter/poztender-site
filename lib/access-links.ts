import { and, eq, gt } from "drizzle-orm";
import { getDb } from "../db";
import { accessGrants, accessLinks, orders, type Order } from "../db/schema";
import { createAccessToken, hashAccessToken, isWellFormedSecret } from "./payment-session";


export interface IssuedAccessLink {
  token: string;
  expiresAt: Date;
}

/**
 * Returns the token to email for a paid order, creating the row on first use.
 *
 * Deliberately *not* idempotent in the plaintext it returns: only the hash is
 * stored, so a resend cannot recover the previous token and must mint a new one
 * and replace the hash. The row itself is reused (order_id is UNIQUE), so no
 * link accumulates, and the grant is never touched — rotating a link neither
 * creates nor extends access.
 */
export async function issueAccessLink(orderId: number): Promise<IssuedAccessLink | null> {
  const db = getDb();
  const now = new Date();

  const [grant] = await db
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.orderId, orderId))
    .limit(1);

  // No grant, or access already over: there is nothing to hand back.
  if (!grant || grant.revokedAt || grant.validUntil <= now) return null;

  const token = createAccessToken();
  const tokenHash = await hashAccessToken(token);
  // The link expires exactly when access does, so it can never outlive what it
  // restores.
  const expiresAt = grant.validUntil;

  await db
    .insert(accessLinks)
    .values({ orderId, tokenHash, expiresAt, sentAt: null })
    .onConflictDoUpdate({
      target: accessLinks.orderId,
      set: { tokenHash, expiresAt, sentAt: null },
    });

  return { token, expiresAt };
}

/** Records that the link was emailed. Failure to send simply leaves it null. */
export async function markAccessLinkSent(orderId: number) {
  const db = getDb();
  await db
    .update(accessLinks)
    .set({ sentAt: new Date() })
    .where(eq(accessLinks.orderId, orderId));
}

/**
 * Resolves a token to its order, or null.
 *
 * The lookup is by hash, so the database never holds anything replayable, and
 * an unknown or expired token is indistinguishable from a wrong one. The order
 * must already be paid — a token for an order awaiting a bank transfer resolves
 * to nothing.
 */
export async function redeemAccessLink(token: string): Promise<Order | null> {
  if (!isWellFormedSecret(token)) return null;

  const db = getDb();
  const tokenHash = await hashAccessToken(token);
  const now = new Date();

  const [row] = await db
    .select({ order: orders, linkId: accessLinks.id })
    .from(accessLinks)
    .innerJoin(orders, eq(orders.id, accessLinks.orderId))
    .where(and(eq(accessLinks.tokenHash, tokenHash), gt(accessLinks.expiresAt, now)))
    .limit(1);

  if (!row || row.order.status !== "paid") return null;

  // Usage is recorded, not consumed: a customer who opens the email on a phone
  // and later on a desktop must not be locked out by the first click. The
  // window is bounded by expiresAt, and the link still confers nothing on its
  // own.
  await db
    .update(accessLinks)
    .set({ lastUsedAt: now })
    .where(eq(accessLinks.id, row.linkId));

  return row.order;
}
