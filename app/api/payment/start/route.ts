import {
  createInvoiceId,
  createPaymentSignature,
  createReceipt,
  escapeHtml,
  isPaymentReady,
  paymentProduct,
  type RobokassaEnvironment,
} from "../../../../lib/robokassa";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const runtimeEnv = process.env as RobokassaEnvironment;
  if (!isPaymentReady(runtimeEnv)) {
    return Response.redirect(new URL("/payment/unavailable", request.url), 303);
  }

  const email = new URL(request.url).searchParams.get("email")?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    return Response.redirect(new URL("/payment?error=email", request.url), 303);
  }

  const merchantLogin = runtimeEnv.ROBOKASSA_MERCHANT_LOGIN!;
  const invoiceId = createInvoiceId();
  const receipt = createReceipt();
  const origin = new URL(request.url).origin;
  const successUrl = `${origin}/payment/success`;
  const failUrl = `${origin}/payment/failed`;
  const signature = await createPaymentSignature({
    merchantLogin,
    invoiceId,
    password: runtimeEnv.ROBOKASSA_PASSWORD_1!,
    receipt,
    successUrl,
    failUrl,
  });

  const fields: Record<string, string> = {
    MerchantLogin: merchantLogin,
    OutSum: paymentProduct.amount,
    InvId: invoiceId,
    Description: paymentProduct.description,
    SignatureValue: signature,
    Receipt: receipt,
    Culture: "ru",
    Email: email,
    IsTest: runtimeEnv.ROBOKASSA_TEST_MODE === "true" ? "1" : "0",
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
      },
    },
  );
}
