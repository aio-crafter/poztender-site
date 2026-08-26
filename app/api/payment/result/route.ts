import { after } from "next/server";

import { isDatabaseConfigured } from "../../../../db";
import { deliverAccessEmail } from "../../../../lib/access-delivery";
import { createPaymentNotification } from "../../../../lib/intake-notification.mjs";
import { confirmPayment } from "../../../../lib/orders";
import { sendOwnerMessage, type TelegramEnvironment } from "../../../../lib/telegram";
import {
  createResultSignature,
  planForAmount,
  resolvePaymentMode,
  safeEqualHex,
  type RobokassaEnvironment,
} from "../../../../lib/robokassa";

export const dynamic = "force-dynamic";

// InvId is not a secret and is the only key that ties a log line back to a
// Robokassa operation, so it is the one parameter worth recording. Signatures,
// passwords and payer details are never logged.
function logCallback(outcome: string, invoiceId: string) {
  console.error(`[payment] result callback ${outcome} invId=${invoiceId || "-"}`);
}

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

/**
 * The only authoritative confirmation of payment in this application.
 *
 * Robokassa treats `OK{InvId}` as "the shop has taken responsibility for this
 * payment", so that answer is given only after the transaction has committed.
 * Every failure path below returns a non-OK status on purpose, which makes
 * Robokassa retry rather than consider the payment settled.
 */
async function handleResult(request: Request) {
  const runtimeEnv = process.env as RobokassaEnvironment;
  if (!resolvePaymentMode(runtimeEnv).mode) {
    logCallback("rejected:payment-channel-closed", "");
    return new Response("Payment integration is unavailable", { status: 503 });
  }

  if (!isDatabaseConfigured()) {
    logCallback("deferred:database-not-configured", "");
    return new Response("Order store is unavailable", { status: 503 });
  }

  const parameters = await readParameters(request);
  const outSum = parameters.get("OutSum") ?? "";
  const invoiceId = parameters.get("InvId") ?? "";
  const receivedSignature = parameters.get("SignatureValue") ?? "";

  // Robokassa allows InvId up to int64, but this shop only ever issues values
  // below 2^52, and the number has to survive Number() intact to be used as a
  // lookup key. Anything larger cannot be one of ours.
  const invoiceNumber = Number(invoiceId);
  if (
    !/^\d{1,19}$/.test(invoiceId) ||
    !Number.isSafeInteger(invoiceNumber) ||
    invoiceNumber <= 0 ||
    !planForAmount(outSum) ||
    !/^[a-f\d]{64}$/i.test(receivedSignature)
  ) {
    logCallback("rejected:malformed", invoiceId);
    return new Response("Invalid payment notification", { status: 400 });
  }

  // Signature first: nothing else in the request is trusted until the shared
  // secret proves Robokassa sent it.
  const expectedSignature = await createResultSignature({
    outSum,
    invoiceId,
    password: runtimeEnv.ROBOKASSA_PASSWORD_2!,
  });

  if (!safeEqualHex(receivedSignature, expectedSignature)) {
    logCallback("rejected:bad-signature", invoiceId);
    return new Response("Invalid payment signature", { status: 403 });
  }

  let confirmation;
  try {
    confirmation = await confirmPayment({ invoiceId: invoiceNumber, outSum });
  } catch (error) {
    // The payment is real but could not be recorded. Answering OK here would
    // tell Robokassa the order is settled while the customer has no access and
    // no trace exists, so fail loudly and let Robokassa deliver again.
    logCallback("error:persistence-failed", invoiceId);
    console.error("[payment] confirmPayment threw", error instanceof Error ? error.message : error);
    return new Response("Could not record payment", { status: 500 });
  }

  switch (confirmation.outcome) {
    case "unknown-order":
      // Correctly signed but for an invoice this shop never issued.
      logCallback("rejected:unknown-order", invoiceId);
      return new Response("Unknown order", { status: 404 });

    case "amount-mismatch":
      logCallback("rejected:amount-mismatch", invoiceId);
      return new Response("Amount does not match the order", { status: 400 });

    case "not-a-robokassa-order":
      // A business order settles by bank transfer, never through Robokassa.
      // Acknowledging this would mark an unpaid invoice as settled.
      logCallback("rejected:business-order", invoiceId);
      return new Response("Order is not payable through Robokassa", { status: 409 });

    case "already-paid":
      // A retry or a concurrent delivery. Nothing was changed: paidAt keeps its
      // original value and no second grant exists. Robokassa still needs OK.
      logCallback("accepted:duplicate", invoiceId);
      break;

    case "confirmed": {
      logCallback("accepted:confirmed", invoiceId);
      // Everything below runs after confirmPayment's transaction has committed,
      // and only on this branch: "confirmed" is returned to exactly one caller
      // because the conditional UPDATE inside that transaction lets only one
      // win. A retry lands on "already-paid" above and schedules nothing.

      // The owner's notification leaves the critical path. Telegram can take
      // twenty seconds to fail — twelve on the relay, eight on the direct call —
      // and Robokassa must not wait for that to hear OK. after() hands the task
      // to the platform's waitUntil (server.mjs collects it and drains it once
      // the response is written), so this is tracked background work rather
      // than a floating promise nobody owns.
      after(
        sendOwnerMessage(
          process.env as TelegramEnvironment,
          createPaymentNotification({
            invoiceId: String(confirmation.order.invoiceId),
            amount: confirmation.order.expectedAmount,
            plan: confirmation.order.plan,
            email: confirmation.order.email,
            status: confirmation.order.status,
          }),
          "[payment]",
        ).then((delivery) => {
          // Observability survives the move: the callback has already been
          // answered, so this is the only record that the owner was not told.
          // `reason` is a fixed label, never a secret.
          if (!delivery.ok) {
            logCallback(`accepted:confirmed-telegram-${delivery.reason}`, invoiceId);
          }
        }),
      );

      // The access email stays on the critical path deliberately. It is the
      // customer's only way back in after losing the cookie, nothing retries it
      // automatically, and a container recycled between the response and a
      // background task would lose it silently. It costs one HTTPS request to
      // the mail relay, which is bounded and short.
      try {
        const outcome = await deliverAccessEmail(
          confirmation.order,
          new URL(request.url).origin,
        );
        if (outcome !== "sent") {
          logCallback(`accepted:confirmed-mail-${outcome}`, invoiceId);
        }
      } catch (error) {
        console.error(
          "[payment] access email threw",
          error instanceof Error ? error.message : error,
        );
      }
      break;
    }
  }

  return new Response(`OK${invoiceId}`, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export const GET = handleResult;
export const POST = handleResult;
