export const dynamic = "force-dynamic";

interface RelayEnvironment {
  TELEGRAM_OWNER_CHAT_ID?: string;
  TELEGRAM_OWNER_USERNAME?: string;
  TELEGRAM_RELAY_SECRET?: string;
}

function reply(body: Record<string, unknown>, status: number) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}

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

export async function POST(request: Request) {
  const env = process.env as RelayEnvironment;
  const relaySecret = env.TELEGRAM_RELAY_SECRET ?? "";
  const suppliedSecret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (relaySecret.length < 32 || suppliedSecret !== relaySecret) {
    return reply({ ok: false }, 401);
  }

  const token = request.headers.get("x-telegram-bot-token") ?? "";
  if (!/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    return reply({ ok: false }, 503);
  }

  let text = "";
  try {
    const body = (await request.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim().slice(0, 3900) : "";
  } catch {
    return reply({ ok: false }, 400);
  }
  if (!text) return reply({ ok: false }, 400);

  const chatId = await resolveOwnerChatId(
    token,
    env.TELEGRAM_OWNER_CHAT_ID ?? "",
    env.TELEGRAM_OWNER_USERNAME ?? "kruger79",
  );
  if (!chatId) {
    console.error(
      "[telegram-relay] could not resolve owner chat id; set TELEGRAM_OWNER_CHAT_ID to avoid dropping paid submissions",
    );
    return reply({ ok: false, needsStart: true }, 503);
  }

  let telegramResponse: Response;
  try {
    telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    console.error("[telegram-relay] sendMessage request threw", error);
    return reply({ ok: false }, 502);
  }

  if (!telegramResponse.ok) {
    console.error(`[telegram-relay] sendMessage failed with status ${telegramResponse.status}`);
  }

  return reply({ ok: telegramResponse.ok }, telegramResponse.ok ? 201 : 502);
}
