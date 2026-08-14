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
    return sendJson(response, 401, { ok: false });
  }

  const token = String(request.headers["x-telegram-bot-token"] ?? "");
  if (!/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    return sendJson(response, 503, { ok: false });
  }

  const body = readJsonBody(request);
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 3900) : "";
  if (!text) return sendJson(response, 400, { ok: false });

  const ownerUsername = (process.env.TELEGRAM_OWNER_USERNAME ?? "kruger79")
    .replace(/^@/, "")
    .toLowerCase();

  try {
    const updatesResponse = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?allowed_updates=%5B%22message%22%5D&limit=100`,
      { cache: "no-store", signal: AbortSignal.timeout(8_000) },
    );
    if (!updatesResponse.ok) return sendJson(response, 502, { ok: false });

    const updates = await updatesResponse.json();
    const ownerMessage = (updates.result ?? [])
      .map((update) => update.message)
      .filter((message) => message?.chat?.type === "private")
      .findLast((message) => {
        const username = message?.chat?.username ?? message?.from?.username ?? "";
        return username.toLowerCase() === ownerUsername;
      });
    const chatId = ownerMessage?.chat?.id;
    if (!chatId) return sendJson(response, 503, { ok: false, needsStart: true });

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
    return sendJson(response, telegramResponse.ok ? 201 : 502, {
      ok: telegramResponse.ok,
    });
  } catch {
    return sendJson(response, 502, { ok: false });
  }
}
