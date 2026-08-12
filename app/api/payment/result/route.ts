import {
  createResultSignature,
  isPaymentReady,
  paymentProduct,
  safeEqualHex,
  type RobokassaEnvironment,
} from "../../../../lib/robokassa";

export const dynamic = "force-dynamic";

async function readParameters(request: Request) {
  if (request.method === "GET") {
    return new URL(request.url).searchParams;
  }

  const body = await request.formData();
  const parameters = new URLSearchParams();
  for (const [key, value] of body.entries()) {
    if (typeof value === "string") parameters.append(key, value);
  }
  return parameters;
}

async function handleResult(request: Request) {
  const runtimeEnv = process.env as RobokassaEnvironment;
  if (!isPaymentReady(runtimeEnv)) {
    return new Response("Payment integration is unavailable", { status: 503 });
  }

  const parameters = await readParameters(request);
  const outSum = parameters.get("OutSum") ?? "";
  const invoiceId = parameters.get("InvId") ?? "";
  const receivedSignature = parameters.get("SignatureValue") ?? "";

  if (
    !/^\d{1,19}$/.test(invoiceId) ||
    Number(outSum) !== Number(paymentProduct.amount) ||
    !/^[a-f\d]{64}$/i.test(receivedSignature)
  ) {
    return new Response("Invalid payment notification", { status: 400 });
  }

  const expectedSignature = await createResultSignature({
    outSum,
    invoiceId,
    password: runtimeEnv.ROBOKASSA_PASSWORD_2!,
  });

  if (!safeEqualHex(receivedSignature, expectedSignature)) {
    return new Response("Invalid payment signature", { status: 403 });
  }

  // Robokassa remains the payment/order system of record. A valid callback is
  // acknowledged idempotently; no customer or card data is persisted here.
  return new Response(`OK${invoiceId}`, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export const GET = handleResult;
export const POST = handleResult;
