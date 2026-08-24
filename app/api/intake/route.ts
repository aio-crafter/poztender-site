import { isDatabaseConfigured } from "../../../db";
import {
  createIntakeNotification,
  validateIntakeSubmission,
} from "../../../lib/intake";
import { claimGrant, findSelectedOrder, isGrantActive } from "../../../lib/orders";
import {
  readOrderSelectorFromHeader,
  readSessionSecret,
} from "../../../lib/payment-session";
import {
  sendIntakeConfirmationEmail,
  type EmailEnvironment,
} from "../../../lib/email";
import {
  hasTelegramToken,
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

  const env = process.env as TelegramEnvironment;
  if (!hasTelegramToken(env)) {
    console.error("[intake] TELEGRAM_BOT_TOKEN is missing or malformed");
    return json({
      ok: false,
      error: "Канал приёма анкет временно настраивается. Данные не отправлены — воспользуйтесь контактом ниже.",
    }, 503);
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

  // Spending the grant only after delivery succeeds keeps a transient Telegram
  // failure from burning a paid customer's single submission. The conditional
  // UPDATE inside claimGrant makes the write itself safe to race.
  const grantId = state.grant!.id;

  async function notifyByEmail() {
    try {
      await sendIntakeConfirmationEmail(process.env as EmailEnvironment, {
        to: submission.email,
        company: submission.company,
        contactName: submission.contactName,
        replyChannel: submission.replyChannel,
        telegram: submission.telegram,
      });
    } catch (error) {
      console.error("[intake] confirmation email threw", error);
    }
  }

  const delivery = await sendOwnerMessage(env, notification, "[intake]");
  if (!delivery.ok) {
    if (delivery.reason === "no-chat-id") {
      return json({
        ok: false,
        error: "Канал приёма анкет ждёт активации. Владелец должен один раз отправить боту /start.",
      }, 503);
    }
    if (delivery.reason === "request-failed") {
      return json({
        ok: false,
        error: "Не удалось доставить анкету. Данные не потеряны в форме — попробуйте ещё раз.",
      }, 502);
    }
    return json({
      ok: false,
      error: "Канал уведомлений временно недоступен. Попробуйте ещё раз или воспользуйтесь контактом ниже.",
    }, 502);
  }

  await claimGrant(grantId);
  await notifyByEmail();
  return json({ ok: true }, 201);
}
