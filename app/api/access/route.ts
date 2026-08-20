import { isDatabaseConfigured } from "../../../db";
import { redeemAccessLink } from "../../../lib/access-links";
import { findGrantForOrder, isGrantActive } from "../../../lib/orders";
import { buildSetCookie } from "../../../lib/payment-session";

export const dynamic = "force-dynamic";

/** Where a paid order continues. A subscription renewal needs no intake form. */
function nextStepFor(plan: string) {
  return plan === "subscription" ? "/payment/success" : "/brief";
}

/**
 * Restores a checkout session from an emailed recovery link.
 *
 * This is the only way back in after a cookie is lost, a different browser is
 * used, or a bank transfer is confirmed days later. It grants nothing by
 * itself: the token must resolve to an order that is already `paid` with a live
 * grant, and every page downstream still checks `isGrantActive()`. No grant is
 * created or extended here, and the redirect target is derived from the order's
 * plan — never from anything in the request, so there is no open redirect.
 */
export async function GET(request: Request) {
  const failed = () => Response.redirect(new URL("/payment/link-expired", request.url), 303);

  if (!isDatabaseConfigured()) return failed();

  const token = new URL(request.url).searchParams.get("token");
  if (!token) return failed();

  let order;
  try {
    order = await redeemAccessLink(token);
  } catch (error) {
    console.error("[access] redemption failed", error instanceof Error ? error.message : error);
    return failed();
  }
  // A bad, expired or unpaid token is reported identically, so the endpoint
  // cannot be used to probe which orders exist.
  if (!order) return failed();

  const grant = await findGrantForOrder(order.id);
  if (!isGrantActive(grant, order)) return failed();

  // The cookie is set to the token itself. Nothing is rewritten on the order,
  // so a session restored on a phone does not evict the one on a desktop —
  // both secrets resolve to the same order.
  const url = new URL(request.url);
  // The session must not expire before the access it restores.
  const remainingSeconds = Math.ceil((grant!.validUntil.getTime() - Date.now()) / 1000);

  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(nextStepFor(order.plan), request.url).toString(),
      "cache-control": "no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "set-cookie": buildSetCookie(token, {
        secure: url.protocol === "https:",
        maxAgeSeconds: remainingSeconds,
      }),
    },
  });
}
