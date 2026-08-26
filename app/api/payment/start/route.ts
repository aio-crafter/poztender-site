import { isDatabaseConfigured } from "../../../../db";
import { validateBuyer } from "../../../../lib/buyer";
import { createBusinessOrderNotification } from "../../../../lib/intake";
import { createPendingOrder } from "../../../../lib/orders";
import type { Order } from "../../../../db/schema";
import { sendOwnerMessage, type TelegramEnvironment } from "../../../../lib/telegram";
import {
  buildOrderCookie,
  buildSetCookie,
  createSessionSecret,
  hashSessionSecret,
  readSessionSecret,
} from "../../../../lib/payment-session";
import {
  createPaymentSignature,
  createReceipt,
  escapeHtml,
  productForPlan,
  resolvePaymentMode,
  type PaymentPlan,
  type RobokassaEnvironment,
} from "../../../../lib/robokassa";

export const dynamic = "force-dynamic";

/** Only these identifiers exist. Anything else is not a tariff. */
function readPlan(value: string | null): PaymentPlan {
  return value === "subscription" ? "subscription" : "pilot";
}

const SUBMISSION_FIELDS = ["plan", "email", "buyerType", "buyerInn", "buyerName"] as const;
type Submission = Record<(typeof SUBMISSION_FIELDS)[number], string | null>;

async function readSubmission(request: Request): Promise<Submission> {
  const empty = Object.fromEntries(SUBMISSION_FIELDS.map((name) => [name, null])) as Submission;

  if (request.method === "GET") {
    const { searchParams } = new URL(request.url);
    return Object.fromEntries(
      SUBMISSION_FIELDS.map((name) => [name, searchParams.get(name)]),
    ) as Submission;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("form-data")) {
    const form = await request.formData();
    return Object.fromEntries(
      SUBMISSION_FIELDS.map((name) => {
        const value = form.get(name);
        return [name, typeof value === "string" ? value : null];
      }),
    ) as Submission;
  }

  return empty;
}

// Starting a checkout now writes a row, so the endpoint needs a ceiling that
// the previous stateless version did not: without one, anyone could fill the
// orders table by replaying the request. In-memory like the intake limiter, so
// it resets on restart — a first barrier, not a guarantee.
const startAttempts = new Map<string, number[]>();

function isStartRateLimited(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const key = (forwardedFor || "unknown").slice(0, 80);
  const now = Date.now();
  const recent = (startAttempts.get(key) ?? []).filter((time) => now - time < 10 * 60_000);
  if (recent.length >= 20) return true;
  recent.push(now);
  startAttempts.set(key, recent);
  return false;
}

async function handleStart(request: Request) {
  const runtimeEnv = process.env as RobokassaEnvironment;

  if (!isDatabaseConfigured()) {
    // Without an order store a payment cannot be recorded, and an unrecorded
    // payment is worse than one that never started. Quiet like the other
    // intended resting states — the closed checkout is the signal.
    return Response.redirect(new URL("/payment/unavailable", request.url), 303);
  }

  const submission = await readSubmission(request);
  const plan = readPlan(submission.plan);
  const errorPath = plan === "subscription" ? "/renew" : "/payment";

  if (isStartRateLimited(request)) {
    return Response.redirect(new URL(`${errorPath}?error=rate`, request.url), 303);
  }

  const email = submission.email?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    return Response.redirect(new URL(`${errorPath}?error=email`, request.url), 303);
  }

  // Server-side and authoritative. The browser decides nothing here: a missing
  // or tampered buyer type can only fall back to "individual", which is the
  // case that carries no tax details at all.
  const buyerCheck = validateBuyer(submission);
  if (!buyerCheck.ok) {
    return Response.redirect(new URL(`${errorPath}?error=${buyerCheck.error}`, request.url), 303);
  }

  const isBusiness = buyerCheck.buyer.buyerType === "business";

  // An individual pays by card, so Robokassa's configuration is checked before
  // anything is written: a closed card checkout must not leave orphan orders
  // behind. A business order is unaffected — it never uses that rail.
  const paymentMode = resolvePaymentMode(runtimeEnv);
  if (!isBusiness && !paymentMode.mode) {
    // Missing credentials and a deliberately unconfirmed receipt flag are
    // intended resting states, so they stay quiet. An ambiguous flag is not:
    // it means someone wrote a value like "True" or "1" and the checkout is
    // closed only because this refuses to guess. That needs to reach the
    // hosting log. The reason names the variable at fault, never its value.
    if (paymentMode.reason.startsWith("ambiguous-")) {
      console.error(`[payment] checkout closed, fix this variable: ${paymentMode.reason}`);
    }
    return Response.redirect(new URL("/payment/unavailable", request.url), 303);
  }

  // The price is looked up from the plan identifier here and written to the
  // order before anything is signed. Nothing the browser sent can reach it.
  const product = productForPlan(plan);

  // Reuse the browser's existing checkout session when it has one. Minting a
  // fresh secret on every attempt would orphan the earlier order: a customer
  // who pressed back, started again, and then completed the *first* Robokassa
  // page would end up holding a cookie that points at the wrong order.
  const sessionSecret = readSessionSecret(request.headers.get("cookie")) ?? createSessionSecret();

  let order: Order;
  try {
    order = await createPendingOrder({
      plan,
      email,
      sessionHash: await hashSessionSecret(sessionSecret),
      buyer: buyerCheck.buyer,
    });
  } catch (error) {
    console.error("[payment] could not create order", error instanceof Error ? error.message : error);
    return Response.redirect(new URL(`${errorPath}?error=store`, request.url), 303);
  }

  const url = new URL(request.url);
  const secure = url.protocol === "https:";

  /**
   * Two cookies, two jobs. The secret proves the browser owns its orders; the
   * selector names which one it is working on now. Neither is enough alone: the
   * selector holds a public invoice number and is always re-checked against the
   * session before an order is returned.
   */
  function sessionHeaders(base: Record<string, string>) {
    const headers = new Headers(base);
    headers.append("set-cookie", buildSetCookie(sessionSecret, { secure }));
    headers.append("set-cookie", buildOrderCookie(String(order.invoiceId), { secure }));
    return headers;
  }

  // Robokassa accepts payments from individuals only, confirmed by their
  // support. A business order therefore never reaches Robokassa at all: no
  // signature is computed, no Receipt is built and the buyer's tax details are
  // never sent there. It waits for a bank transfer instead.
  if (isBusiness) {
    // Nothing else announces this order: there is no Robokassa callback for a
    // bank transfer, so without this the buyer would wait for an invoice
    // nobody knew to raise. Delivery is awaited so a failure is logged before
    // the response, but it can never undo the order — the row is already
    // committed and the invoice page works regardless.
    try {
      const notification = createBusinessOrderNotification({
        invoiceId: String(order.invoiceId),
        buyerName: order.buyerName ?? "",
        buyerInn: order.buyerInn ?? "",
        email: order.email,
        plan: order.plan,
        amount: order.expectedAmount,
        status: order.status,
      });
      const delivery = await sendOwnerMessage(
        process.env as TelegramEnvironment,
        notification,
        "[payment]",
      );
      if (!delivery.ok) {
        // The reason is a fixed identifier; the message, the bot token and the
        // buyer's details are not logged.
        console.error(
          `[payment] business order notification not delivered: ${delivery.reason} invId=${order.invoiceId}`,
        );
      }
    } catch (error) {
      console.error(
        "[payment] business order notification threw",
        error instanceof Error ? error.message : error,
      );
    }

    return new Response(null, {
      status: 303,
      headers: sessionHeaders({
        location: new URL("/payment/invoice", request.url).toString(),
        "cache-control": "no-store, max-age=0",
      }),
    });
  }

  const merchantLogin = runtimeEnv.ROBOKASSA_MERCHANT_LOGIN!;
  const invoiceId = String(order.invoiceId);
  const receipt = createReceipt(product);
  const signature = await createPaymentSignature({
    merchantLogin,
    amount: product.amount,
    invoiceId,
    password: runtimeEnv.ROBOKASSA_PASSWORD_1!,
    receipt,
  });

  // Where the customer comes back to is configured in the Robokassa account,
  // not sent per request. The SuccessUrl2/FailUrl2 fields that used to be here
  // were refused with error 29 by the live endpoint in every encoding tried,
  // while the identical request without them was accepted. Success and Fail
  // URLs live in the merchant account: https://poztender.ru/payment/success
  // (GET) and https://poztender.ru/payment/failed (GET). Do not reintroduce
  // them as form fields — see createPaymentSignature.
  const fields: Record<string, string> = {
    MerchantLogin: merchantLogin,
    OutSum: product.amount,
    InvId: invoiceId,
    Description: product.description,
    SignatureValue: signature,
    Receipt: receipt,
    Culture: "ru",
    Email: email,
    // Derived from the same resolved mode that opened the checkout, so the
    // gate and the flag sent to Robokassa can never disagree.
    IsTest: paymentMode.mode === "test" ? "1" : "0",
  };

  const inputs = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");

  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>Переход к оплате — ПожТендер</title></head><body><main><p>Переходим на защищённую страницу оплаты…</p><form action="https://auth.robokassa.ru/Merchant/Index.aspx" method="post">${inputs}<button type="submit">Перейти к оплате</button></form></main><script>document.forms[0].submit()</script></body></html>`,
    {
      status: 200,
      headers: sessionHeaders({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "content-security-policy":
          "default-src 'none'; form-action https://auth.robokassa.ru; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      }),
    },
  );
}

export const GET = handleStart;
export const POST = handleStart;
