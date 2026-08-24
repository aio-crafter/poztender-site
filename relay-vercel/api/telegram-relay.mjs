function sendJson(response, status, body) {
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader("x-content-type-options", "nosniff");
  return response.status(status).json(body);
}

function readJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body !== "string") return {};
  try {
    return JSON.parse(request.body);
  } catch {
    return {};
  }
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    return sendJson(response, 405, { ok: false });
  }

  const relaySecret = process.env.TELEGRAM_RELAY_SECRET ?? "";
  const suppliedSecret = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (relaySecret.length < 32 || suppliedSecret !== relaySecret) {
    console.error("[relay] auth rejected");
    return sendJson(response, 401, { ok: false, reason: "auth-rejected" });
  }

  const token = String(request.headers["x-telegram-bot-token"] ?? "");
  if (!/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    console.error("[relay] bot token header missing or malformed");
    return sendJson(response, 503, { ok: false, reason: "token-invalid" });
  }

  const body = readJsonBody(request);
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 3900) : "";
  if (!text) {
    console.error("[relay] empty message text");
    return sendJson(response, 400, { ok: false, reason: "bad-request" });
  }

  const configuredChatId = process.env.TELEGRAM_OWNER_CHAT_ID ?? "";
  const ownerUsername = (process.env.TELEGRAM_OWNER_USERNAME ?? "kruger79")
    .replace(/^@/, "")
    .toLowerCase();

  try {
    // Prefer an explicitly configured owner chat id, exactly as
    // app/api/telegram-relay does. Resolving through getUpdates() is fragile:
    // Telegram only retains a limited backlog, and an owner without a public
    // @username can never be matched at all — either way a paid customer's
    // submission is dropped. With the id configured, getUpdates is skipped.
    let chatId = "";
    if (/^-?\d{5,20}$/.test(configuredChatId)) {
      chatId = configuredChatId;
    } else {
      const updatesResponse = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?allowed_updates=%5B%22message%22%5D&limit=100`,
        { cache: "no-store", signal: AbortSignal.timeout(8_000) },
      );
      if (!updatesResponse.ok) {
        console.error(`[relay] getUpdates failed with status ${updatesResponse.status}`);
        return sendJson(response, 502, { ok: false, reason: "telegram-rejected" });
      }

      const updates = await updatesResponse.json();
      const ownerMessage = (updates.result ?? [])
        .map((update) => update.message)
        .filter((message) => message?.chat?.type === "private")
        .findLast((message) => {
          const username = message?.chat?.username ?? message?.from?.username ?? "";
          return username.toLowerCase() === ownerUsername;
        });
      chatId = ownerMessage?.chat?.id ? String(ownerMessage.chat.id) : "";
    }

    if (!chatId) {
      // The username is not a secret; the chat id is not printed.
      console.error(
        `[relay] owner chat id unresolved for username=${ownerUsername}; set TELEGRAM_OWNER_CHAT_ID`,
      );
      return sendJson(response, 503, { ok: false, reason: "no-chat-id", needsStart: true });
    }

    const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
    if (!telegramResponse.ok) {
      // Status only: the response body can carry user data.
      console.error(`[relay] sendMessage failed with status ${telegramResponse.status}`);
      return sendJson(response, 502, { ok: false, reason: "telegram-rejected" });
    }
    return sendJson(response, 201, { ok: true });
  } catch (error) {
    // Error name only — never the message, which can quote the request.
    console.error(`[relay] telegram request threw ${error?.name ?? "Error"}`);
    return sendJson(response, 502, { ok: false, reason: "telegram-timeout" });
  }
}
