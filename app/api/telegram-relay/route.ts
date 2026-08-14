export const dynamic = "force-dynamic";

interface RelayEnvironment {
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

  const ownerUsername = (env.TELEGRAM_OWNER_USERNAME ?? "kruger79")
    .replace(/^@/, "")
    .toLowerCase();
  const updatesResponse = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?allowed_updates=%5B%22message%22%5D&limit=100`,
    { cache: "no-store", signal: AbortSignal.timeout(8_000) },
  );
  if (!updatesResponse.ok) return reply({ ok: false }, 502);

  const updates = (await updatesResponse.json()) as {
    result?: Array<{
      message?: {
        chat?: { id?: number; type?: string; username?: string };
        from?: { username?: string };
      };
    }>;
  };
  const ownerMessage = (updates.result ?? [])
    .map((update) => update.message)
    .filter((message) => message?.chat?.type === "private")
    .findLast((message) => {
      const username = message?.chat?.username ?? message?.from?.username ?? "";
      return username.toLowerCase() === ownerUsername;
    });
  const chatId = ownerMessage?.chat?.id;
  if (!chatId) return reply({ ok: false, needsStart: true }, 503);

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
  return reply({ ok: telegramResponse.ok }, telegramResponse.ok ? 201 : 502);
}
