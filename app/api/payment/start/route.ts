import { isDatabaseConfigured } from "../../../../db";
import { createPendingOrder } from "../../../../lib/orders";
import {
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

async function readSubmission(request: Request) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    return { plan: url.searchParams.get("plan"), email: url.searchParams.get("email") };
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("form-data")) {
    const form = await request.formData();
    const plan = form.get("plan");
    const email = form.get("email");
    return {
      plan: typeof plan === "string" ? plan : null,
      email: typeof email === "string" ? email : null,
    };
  }

  return { plan: null, email: null };
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
  const paymentMode = resolvePaymentMode(runtimeEnv);
  if (!paymentMode.mode) {
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

  if (!isDatabaseConfigured()) {
    // Without an order store a payment cannot be recorded, and an unrecorded
    // payment is worse than one that never started.
    console.error("[payment] checkout closed: DATABASE_URL is not set");
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

  // The price is looked up from the plan identifier here and written to the
  // order before anything is signed. Nothing the browser sent can reach it.
  const product = productForPlan(plan);

  // Reuse the browser's existing checkout session when it has one. Minting a
  // fresh secret on every attempt would orphan the earlier order: a customer
  // who pressed back, started again, and then completed the *first* Robokassa
  // page would end up holding a cookie that points at the wrong order.
  const sessionSecret = readSessionSecret(request.headers.get("cookie")) ?? createSessionSecret();

  let order;
  try {
    order = await createPendingOrder({
      plan,
      email,
      sessionHash: await hashSessionSecret(sessionSecret),
    });
  } catch (error) {
    console.error("[payment] could not create order", error instanceof Error ? error.message : error);
    return Response.redirect(new URL(`${errorPath}?error=store`, request.url), 303);
  }

  const url = new URL(request.url);
  const origin = url.origin;
  const successUrl = `${origin}/payment/success`;
  const failUrl = `${origin}/payment/failed`;
  const merchantLogin = runtimeEnv.ROBOKASSA_MERCHANT_LOGIN!;
  const invoiceId = String(order.invoiceId);
  const receipt = createReceipt(product);
  const signature = await createPaymentSignature({
    merchantLogin,
    amount: product.amount,
    invoiceId,
    password: runtimeEnv.ROBOKASSA_PASSWORD_1!,
    receipt,
    successUrl,
    failUrl,
  });

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
    SuccessUrl2: successUrl,
    SuccessUrl2Method: "GET",
    FailUrl2: failUrl,
    FailUrl2Method: "GET",
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
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "content-security-policy":
          "default-src 'none'; form-action https://auth.robokassa.ru; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "set-cookie": buildSetCookie(sessionSecret, { secure: url.protocol === "https:" }),
      },
    },
  );
}

export const GET = handleStart;
export const POST = handleStart;
