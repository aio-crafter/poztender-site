// Access-link issuing and delivery for the administrative scripts.
//
// The scripts run straight from source with no build step, so they cannot
// import the TypeScript layer the app uses. The SQL here mirrors
// lib/access-links.ts, and the email template and transport are the same
// modules the app uses, so the customer receives an identical message either
// way. tests/access-delivery.test.mjs pins the two implementations together.
import { createHash, randomBytes } from "node:crypto";
import { accessEmailHtml, accessEmailSubject } from "../../lib/access-email.mjs";
import { sendMail } from "../../lib/smtp.mjs";

export function createAccessToken() {
  return randomBytes(32).toString("base64url");
}

export function hashAccessToken(token) {
  return createHash("sha256").update(`poztender-access-link:${token}`, "utf8").digest("hex");
}

/**
 * Mints a fresh token for a paid order and stores only its hash.
 *
 * The row is keyed by order_id, so a resend replaces the token rather than
 * accumulating links. The grant is never read for writing and never touched:
 * issuing a link neither creates access nor extends it.
 */
export async function issueAccessLink(client, orderId) {
  const { rows } = await client.query(
    `SELECT valid_until, revoked_at FROM access_grants WHERE order_id = $1`,
    [orderId],
  );
  const grant = rows[0];
  if (!grant || grant.revoked_at || new Date(grant.valid_until) <= new Date()) return null;

  const token = createAccessToken();
  await client.query(
    `INSERT INTO access_links (order_id, token_hash, expires_at, sent_at)
     VALUES ($1, $2, $3, NULL)
     ON CONFLICT (order_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, sent_at = NULL`,
    [orderId, hashAccessToken(token), grant.valid_until],
  );

  return { token, expiresAt: new Date(grant.valid_until) };
}

/**
 * Sends the access email. Returns an outcome rather than throwing: the caller
 * has already recorded money and must not roll it back over SMTP.
 */
export async function deliverAccessEmail(client, order, origin) {
  const env = process.env;
  if (!env.YANDEX_SMTP_USER || !env.YANDEX_SMTP_PASSWORD) return "not-configured";

  const link = await issueAccessLink(client, order.id);
  if (!link) return "no-link";

  const url = `${String(origin).replace(/\/+$/, "")}/api/access?token=${link.token}`;
  const sent = await sendMail(env, {
    to: order.email,
    subject: accessEmailSubject(String(order.invoice_id)),
    html: accessEmailHtml({
      invoiceId: String(order.invoice_id),
      amount: order.expected_amount,
      plan: order.plan,
      accessUntil: link.expiresAt,
      url,
    }),
  });
  if (!sent) return "failed";

  await client.query(`UPDATE access_links SET sent_at = now() WHERE order_id = $1`, [order.id]);
  return "sent";
}

export function requireOrigin() {
  const origin = process.env.PUBLIC_ORIGIN;
  if (!origin) throw new Error("PUBLIC_ORIGIN is not set — the access link needs an absolute URL");
  return origin;
}
