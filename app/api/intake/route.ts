import { isDatabaseConfigured } from "../../../db";
import {
  createIntakeNotification,
  validateIntakeSubmission,
} from "../../../lib/intake";
import { findSelectedOrder, isGrantActive } from "../../../lib/orders";
import {
  markIntakeNotified,
  storeIntakeSubmission,
} from "../../../lib/intake-submissions";
import {
  readOrderSelectorFromHeader,
  readSessionSecret,
} from "../../../lib/payment-session";
import {
  sendIntakeConfirmationEmail,
  type EmailEnvironment,
} from "../../../lib/email";
import {
  sendOwnerMessage,
  type TelegramEnvironment,
} from "../../../lib/telegram";

export const dynamic = "force-dynamic";

const rateLimits = new Map<string, number[]>();

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}

function isRateLimited(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const key = (forwardedFor || "unknown").slice(0, 80);
  const now = Date.now();
  const recent = (rateLimits.get(key) ?? []).filter((time) => now - time < 10 * 60_000);
  if (recent.length >= 5) return true;
  recent.push(now);
  rateLimits.set(key, recent);
  return false;
}

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ ok: false, error: "Ожидается анкета в формате JSON." }, 415);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 20_000) {
    return json({ ok: false, error: "Анкета слишком большая." }, 413);
  }
  if (isRateLimited(request)) {
    return json({ ok: false, error: "Слишком много попыток. Повторите через 10 минут." }, 429);
  }

  let body: unknown;
  try {
    const rawBody = await request.text();
    if (rawBody.length > 20_000) {
      return json({ ok: false, error: "Анкета слишком большая." }, 413);
    }
    body = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "Не удалось прочитать анкету." }, 400);
  }

  // Paid access comes from the HttpOnly checkout cookie plus server state.
  // Nothing in the request body contributes to the decision.
  const unpaid = json({
    ok: false,
    error: "Анкета доступна только после подтверждённой оплаты, в том же браузере.",
  }, 402);

  if (!isDatabaseConfigured()) return unpaid;

  const cookieHeader = request.headers.get("cookie");
  const secret = readSessionSecret(cookieHeader);
  const invoiceId = readOrderSelectorFromHeader(cookieHeader);
  if (!secret || invoiceId === null) return unpaid;

  let state;
  try {
    state = await findSelectedOrder(secret, invoiceId);
  } catch (error) {
    console.error("[intake] access lookup failed", error instanceof Error ? error.message : error);
    return json({ ok: false, error: "Сервис временно недоступен. Попробуйте ещё раз." }, 503);
  }

  if (!state || state.order.plan !== "pilot" || !isGrantActive(state.grant, state.order)) {
    return unpaid;
  }
  if (state.grant!.usedAt) {
    return json({ ok: false, error: "Эта оплаченная анкета уже была отправлена." }, 409);
  }

  const validation = validateIntakeSubmission(body);
  if (!validation.ok) {
    return json({ ok: false, error: validation.error }, 400);
  }
  // Held in its own binding: TypeScript loses the `ok: true` narrowing inside
  // the closure below, and this keeps the value correctly typed there.
  const submission = validation.data;

  // The form is accepted by PostgreSQL, before any external system is
  // touched. Telegram and SMTP used to gate this response, so an unreachable
  // relay told a paying customer their submission had failed while their data
  // existed nowhere. Delivery is now a retryable side effect of a fact that is
  // already committed.
  let stored;
  try {
    stored = await storeIntakeSubmission({
      orderId: state.order.id,
      grantId: state.grant!.id,
      data: submission,
    });
  } catch (error) {
    // The database is the one dependency that may refuse the form: without it
    // the answers exist nowhere, so the customer must be asked to retry.
    console.error("[intake] could not store submission", error instanceof Error ? error.message : error);
    return json({
      ok: false,
      error: "Не удалось сохранить анкету. Данные не потеряны в форме — попробуйте ещё раз.",
    }, 503);
  }

  if (stored.outcome === "already-submitted") {
    return json({ ok: false, error: "Эта оплаченная анкета уже была отправлена." }, 409);
  }

  const notification = createIntakeNotification(
    submission,
    String(state.order.invoiceId),
    {
      buyerType: state.order.buyerType,
      buyerInn: state.order.buyerInn,
      buyerName: state.order.buyerName,
    },
  );

  // Independent on purpose: neither channel can fail the other, and neither
  // can fail the response. Nothing here throws out of the handler.
  const [telegram, email] = await Promise.all([
    sendOwnerMessage(process.env as TelegramEnvironment, notification, "[intake]").catch((error) => {
      console.error("[intake] owner notification threw", error);
      return { ok: false as const, reason: "request-failed" as const };
    }),
    sendIntakeConfirmationEmail(process.env as EmailEnvironment, {
      to: submission.email,
      company: submission.company,
      contactName: submission.contactName,
      replyChannel: submission.replyChannel,
      telegram: submission.telegram,
    }).catch((error) => {
      console.error("[intake] confirmation email threw", error);
      return false;
    }),
  ]);

  if (!telegram.ok) {
    // Loud, because the owner does not yet know a paid customer is waiting.
    // The submission is stored: `npm run resend-intake` delivers it later.
    console.error(
      `[intake] submission ${stored.submission.id} stored but not delivered to the owner (${telegram.reason})`,
    );
  }
  if (!email) {
    console.error(`[intake] submission ${stored.submission.id} stored but no confirmation email was sent`);
  }

  try {
    await markIntakeNotified(stored.submission.id, { telegram: telegram.ok, email });
  } catch (error) {
    // A missing stamp only means the retry script will offer it again.
    console.error("[intake] could not record notification state", error instanceof Error ? error.message : error);
  }

  return json({ ok: true }, 201);
}