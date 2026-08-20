export interface TelegramEnvironment {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_CHAT_ID?: string;
  TELEGRAM_OWNER_USERNAME?: string;
  TELEGRAM_RELAY_AUTH_TOKEN?: string;
  TELEGRAM_RELAY_SECRET?: string;
  TELEGRAM_RELAY_URL?: string;
}

export type TelegramDelivery =
  | { ok: true; via: "relay" | "direct" }
  | { ok: false; reason: "not-configured" | "no-chat-id" | "request-failed" | "rejected" };

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

async function sendThroughRelay(env: TelegramEnvironment, token: string, text: string) {
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
    console.error("[telegram] relay request threw", error);
    return new Response(null, { status: 502 });
  }
}

export function hasTelegramToken(env: TelegramEnvironment) {
  return /^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(env.TELEGRAM_BOT_TOKEN ?? "");
}

/**
 * Delivers a message to the owner, relay first and the Telegram API second.
 *
 * The relay exists for hosts that cannot reach api.telegram.org directly; a
 * relay failure falls through to a direct call rather than giving up, because
 * giving up would drop a paid customer's submission that the direct path might
 * well have delivered.
 *
 * Nothing here logs the bot token, the relay secret or any part of the
 * message: failures are reported by status and reason only.
 */
export async function sendOwnerMessage(
  env: TelegramEnvironment,
  text: string,
  logPrefix: string,
): Promise<TelegramDelivery> {
  if (!hasTelegramToken(env)) {
    console.error(`${logPrefix} TELEGRAM_BOT_TOKEN is missing or malformed`);
    return { ok: false, reason: "not-configured" };
  }
  const token = env.TELEGRAM_BOT_TOKEN!;

  const relayResponse = await sendThroughRelay(env, token, text);
  if (relayResponse?.ok) return { ok: true, via: "relay" };
  if (relayResponse) {
    console.error(
      `${logPrefix} telegram relay failed with status ${relayResponse.status}; falling back to direct Telegram API`,
    );
  }

  const chatId = await resolveOwnerChatId(
    token,
    env.TELEGRAM_OWNER_CHAT_ID ?? "",
    env.TELEGRAM_OWNER_USERNAME ?? "kruger79",
  );
  if (!chatId) {
    console.error(
      `${logPrefix} could not resolve owner chat id; set TELEGRAM_OWNER_CHAT_ID to avoid dropping notifications`,
    );
    return { ok: false, reason: "no-chat-id" };
  }

  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
    console.error(`${logPrefix} direct Telegram sendMessage request threw`, error);
    return { ok: false, reason: "request-failed" };
  }

  if (!response.ok) {
    console.error(`${logPrefix} direct Telegram sendMessage failed with status ${response.status}`);
    return { ok: false, reason: "rejected" };
  }

  return { ok: true, via: "direct" };
}
