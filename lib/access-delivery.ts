import { accessEmailHtml, accessEmailSubject, accessEmailText } from "./access-email.mjs";
import { issueAccessLink, markAccessLinkSent } from "./access-links";
import type { Order } from "../db/schema";
import { sendMail } from "./smtp.mjs";

export type DeliveryOutcome = "sent" | "not-configured" | "no-link" | "failed";

/**
 * Emails the customer their access link after a payment is confirmed.
 *
 * Called after the money is already recorded, and its result is advisory: a
 * failure here must never undo a paid order or its grant. It creates no grant
 * and extends none — it only mints the pointer that lets the customer back in
 * from any browser.
 */
export async function deliverAccessEmail(order: Order, origin: string): Promise<DeliveryOutcome> {
  const env = process.env as { YANDEX_SMTP_USER?: string; YANDEX_SMTP_PASSWORD?: string };
  if (!env.YANDEX_SMTP_USER || !env.YANDEX_SMTP_PASSWORD) return "not-configured";

  const link = await issueAccessLink(order.id);
  if (!link) return "no-link";

  const url = `${origin.replace(/\/+$/, "")}/api/access?token=${link.token}`;
  const content = {
    invoiceId: String(order.invoiceId),
    amount: order.expectedAmount,
    plan: order.plan,
    accessUntil: link.expiresAt,
    url,
  };
  const sent = await sendMail(env, {
    to: order.email,
    subject: accessEmailSubject(String(order.invoiceId)),
    html: accessEmailHtml(content),
    text: accessEmailText(content),
  });

  if (!sent) return "failed";
  await markAccessLinkSent(order.id);
  return "sent";
}
