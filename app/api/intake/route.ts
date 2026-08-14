import {
  createIntakeNotification,
  validateIntakeSubmission,
} from "../../../lib/intake";
import {
  isIntakeAccessValid,
  type RobokassaEnvironment,
} from "../../../lib/robokassa";
import {
  sendIntakeConfirmationEmail,
  type EmailEnvironment,
} from "../../../lib/email";

export const dynamic = "force-dynamic";

interface TelegramEnvironment {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_CHAT_ID?: string;
  TELEGRAM_OWNER_USERNAME?: string;
  TELEGRAM_RELAY_AUTH_TOKEN?: string;
  TELEGRAM_RELAY_SECRET?: string;
  TELEGRAM_RELAY_URL?: string;
}

const rateLimits = new Map<string, number[]>();
const usedAccessTokens = new Map<string, number>();

// Prefer an explicitly configured owner chat id. Falling back to scanning
// getUpdates() is fragile: Telegram only retains a limited backlog of
// updates, so if the owner has not messaged the bot recently, a paid
// customer's submission can silently fail to deliver. Always set
// TELEGRAM_OWNER_CHAT_ID in the hosting panel for reliable delivery.
async function resolveOwnerChatId(
  token: string,
  configuredChatId: string,
  configuredUsername: string,
) {
  if (/^-?\d{5,20}$/.test(configuredChatId)) return configuredChatId;

  const ownerUsername = configuredUsername.replace(/^@/, "").toLowerCase();
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(ownerUsername)) return "";

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?allowed_updates=%5B%22message%22%5D&limit=100`,
      { cache: "no-store", signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) return "";

    const payload = (await response.json()) as {
      result?: Array<{
        message?: {
          chat?: { id?: number; type?: string; username?: string };
          from?: { username?: string };
        };
      }>;
    };
    const match = (payload.result ?? [])
      .map((update) => update.message)
      .filter((message) => message?.chat?.type === "private")
      .findLast((message) => {
        const username = message?.chat?.username ?? message?.from?.username ?? "";
        return username.toLowerCase() === ownerUsername;
      });

    return match?.chat?.id ? String(match.chat.id) : "";
  } catch {
    return "";
  }
}

async function sendThroughRelay(
  env: TelegramEnvironment,
  token: string,
  text: string,
) {
  const relayUrl = env.TELEGRAM_RELAY_URL ?? "";
  const relaySecret = env.TELEGRAM_RELAY_SECRET ?? "";
  const relayAuthToken = env.TELEGRAM_RELAY_AUTH_TOKEN ?? "";
  if (!/^https:\/\/[^\s]+$/.test(relayUrl) || relaySecret.length < 32) return null;

  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${relaySecret}`,
      "content-type": "application/json",
      "x-telegram-bot-token": token,
    };
    if (relayAuthToken) {
      headers["OAI-Sites-Authorization"] = `Bearer ${relayAuthToken}`;
    }
    return await fetch(relayUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    console.error("[intake] telegram relay request threw", error);
    return new Response(null, { status: 502 });
  }
}

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

  const paymentEnv = process.env as RobokassaEnvironment;
  const access = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const invoiceId = typeof access.invoiceId === "string" ? access.invoiceId : "";
  const outSum = typeof access.outSum === "string" ? access.outSum : "";
  const accessExpires = typeof access.accessExpires === "string" ? access.accessExpires : "";
  const accessToken = typeof access.accessToken === "string" ? access.accessToken : "";
  const paidAccess = Boolean(paymentEnv.ROBOKASSA_PASSWORD_2) && await isIntakeAccessValid({
    invoiceId,
    outSum,
    expires: accessExpires,
    accessToken,
    password: paymentEnv.ROBOKASSA_PASSWORD_2 ?? "",
  });
  if (!paidAccess) {
    return json({
      ok: false,
      error: "Анкета доступна только по персональной ссылке после подтверждённой оплаты.",
    }, 402);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const [key, expires] of usedAccessTokens) {
    if (expires <= nowSeconds) usedAccessTokens.delete(key);
  }
  const accessKey = `${invoiceId}:${accessToken}`;
  if (usedAccessTokens.has(accessKey)) {
    return json({ ok: false, error: "Эта оплаченная анкета уже была отправлена." }, 409);
  }

  const validation = validateIntakeSubmission(body);
  if (!validation.ok) {
    return json({ ok: false, error: validation.error }, 400);
  }

  const env = process.env as TelegramEnvironment;
  const token = env.TELEGRAM_BOT_TOKEN ?? "";
  if (!/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    console.error("[intake] TELEGRAM_BOT_TOKEN is missing or malformed");
    return json({
      ok: false,
      error: "Канал приёма анкет временно настраивается. Данные не отправлены — воспользуйтесь контактом ниже.",
    }, 503);
  }

  const notification = createIntakeNotification(validation.data);

  async function notifyByEmail() {
    try {
      await sendIntakeConfirmationEmail(process.env as EmailEnvironment, {
        to: validation.data.email,
        company: validation.data.company,
        contactName: validation.data.contactName,
      });
    } catch (error) {
      console.error("[intake] confirmation email threw", error);
    }
  }

  // Try the relay first (used when direct calls to api.telegram.org are
  // blocked from the main hosting). Previously, any relay failure returned
  // an error immediately instead of falling back to a direct Telegram API
  // call, which could drop an already-paid customer's submission even
  // though a direct send might have succeeded.
  const relayResponse = await sendThroughRelay(env, token, notification);
  if (relayResponse?.ok) {
    usedAccessTokens.set(accessKey, Number(accessExpires));
    await notifyByEmail();
    return json({ ok: true }, 201);
  }
  if (relayResponse) {
    console.error(
      `[intake] telegram relay failed with status ${relayResponse.status}; falling back to direct Telegram API`,
    );
  }

  const chatId = await resolveOwnerChatId(
    token,
    env.TELEGRAM_OWNER_CHAT_ID ?? "",
    env.TELEGRAM_OWNER_USERNAME ?? "kruger79",
  );
  if (!chatId) {
    console.error(
      "[intake] could not resolve owner chat id; set TELEGRAM_OWNER_CHAT_ID to avoid dropping paid submissions",
    );
    return json({
      ok: false,
      error: "Канал приёма анкет ждёт активации. Владелец должен один раз отправить боту /start.",
    }, 503);
  }

  let telegramResponse: Response;
  try {
    telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: notification,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    console.error("[intake] direct Telegram sendMessage request threw", error);
    return json({
      ok: false,
      error: "Не удалось доставить анкету. Данные не потеряны в форме — попробуйте ещё раз.",
    }, 502);
  }

  if (!telegramResponse.ok) {
    console.error(`[intake] direct Telegram sendMessage failed with status ${telegramResponse.status}`);
    return json({
      ok: false,
      error: "Канал уведомлений временно недоступен. Попробуйте ещё раз или воспользуйтесь контактом ниже.",
    }, 502);
  }

  usedAccessTokens.set(accessKey, Number(accessExpires));
  await notifyByEmail();
  return json({ ok: true }, 201);
}
