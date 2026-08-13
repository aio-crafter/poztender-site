import {
  createIntakeNotification,
  validateIntakeSubmission,
} from "../../../lib/intake";

export const dynamic = "force-dynamic";

interface TelegramEnvironment {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_CHAT_ID?: string;
}

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

  const validation = validateIntakeSubmission(body);
  if (!validation.ok) {
    return json({ ok: false, error: validation.error }, 400);
  }

  const env = process.env as TelegramEnvironment;
  const token = env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = env.TELEGRAM_OWNER_CHAT_ID ?? "";
  if (!/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(token) || !/^-?\d{5,20}$/.test(chatId)) {
    return json({
      ok: false,
      error: "Канал приёма анкет временно настраивается. Данные не отправлены — воспользуйтесь контактом ниже.",
    }, 503);
  }

  let telegramResponse: Response;
  try {
    telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: createIntakeNotification(validation.data),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return json({
      ok: false,
      error: "Не удалось доставить анкету. Данные не потеряны в форме — попробуйте ещё раз.",
    }, 502);
  }

  if (!telegramResponse.ok) {
    return json({
      ok: false,
      error: "Канал уведомлений временно недоступен. Попробуйте ещё раз или воспользуйтесь контактом ниже.",
    }, 502);
  }

  return json({ ok: true }, 201);
}
