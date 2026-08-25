// The Vercel Telegram relay's owner-chat resolution.
//
// Timeweb cannot reach api.telegram.org directly (the request times out), so
// owner notifications go through the relay. The relay used to resolve the
// owner's chat only by scanning getUpdates() for TELEGRAM_OWNER_USERNAME —
// it never read TELEGRAM_OWNER_CHAT_ID, unlike app/api/telegram-relay. That
// backlog is short-lived, and an owner without a public @username can never
// be matched at all, so the relay answered 503 and /api/intake returned 502
// to a paying customer. These tests pin the configured-id shortcut and the
// safe reason labels, and keep the auth semantics from drifting.
//
// Nothing here opens a socket: fetch is intercepted.
import assert from "node:assert/strict";
import test from "node:test";
import handler from "../relay-vercel/api/telegram-relay.mjs";

// Shaped like real credentials, but inert: they authorise nothing.
const BOT_TOKEN = `123456789:${"A".repeat(35)}`;
const RELAY_SECRET = "s".repeat(40);
const CONFIGURED_CHAT_ID = "555000";
const BACKLOG_CHAT_ID = 777111;

function fakeResponse() {
  const sent = { status: 0, body: null, headers: {} };
  return {
    sent,
    setHeader(name, value) {
      sent.headers[name] = value;
    },
    status(code) {
      sent.status = code;
      return this;
    },
    json(body) {
      sent.body = body;
      return this;
    },
  };
}

function fakeRequest({ method = "POST", secret = RELAY_SECRET, token = BOT_TOKEN, body } = {}) {
  const headers = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  if (token !== null) headers["x-telegram-bot-token"] = token;
  return { method, headers, body: body === undefined ? { text: "анкета" } : body };
}

/** Convenience wrapper: sets everything up, calls the handler, tears down. */
async function relay(options = {}, requestOptions = {}) {
  const envKeys = ["TELEGRAM_RELAY_SECRET", "TELEGRAM_OWNER_CHAT_ID", "TELEGRAM_OWNER_USERNAME"];
  const previousEnv = envKeys.map((key) => [key, process.env[key]]);
  const originalFetch = globalThis.fetch;
  const originalError = console.error;

  for (const key of envKeys) delete process.env[key];
  process.env.TELEGRAM_RELAY_SECRET = options.relaySecret ?? RELAY_SECRET;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const calls = [];
  const logs = [];
  console.error = (...args) => logs.push(args.map(String).join(" "));
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.includes("api.telegram.org")) return originalFetch(input, init);
    const kind = url.includes("/getUpdates") ? "getUpdates" : "sendMessage";
    calls.push({ kind, body: init?.body ? JSON.parse(init.body) : null });
    if (options.throws) {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }
    const ok = kind === "getUpdates" ? options.updatesOk !== false : options.sendOk !== false;
    const payload =
      kind === "getUpdates" ? { ok: true, result: options.backlog ?? [] } : { ok };
    return new Response(JSON.stringify(payload), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  };

  const response = fakeResponse();
  try {
    await handler(fakeRequest(requestOptions), response);
    return { ...response.sent, calls, logs };
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function privateMessage(username, chatId = BACKLOG_CHAT_ID) {
  return { message: { chat: { id: chatId, type: "private", username } } };
}

// --- 1. configured numeric chat id ---------------------------------------

test("a configured numeric chat id is used directly and getUpdates is never called", async () => {
  const result = await relay({
    env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID, TELEGRAM_OWNER_USERNAME: "kruger79" },
    backlog: [privateMessage("kruger79")],
  });

  assert.equal(result.calls.length, 1, "exactly one Telegram call");
  assert.equal(result.calls[0].kind, "sendMessage");
  assert.ok(
    !result.calls.some((call) => call.kind === "getUpdates"),
    "getUpdates must be skipped when the id is configured",
  );
  assert.equal(result.calls[0].body.chat_id, CONFIGURED_CHAT_ID);
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { ok: true });
});

test("a negative group chat id is accepted as configured", async () => {
  const result = await relay({ env: { TELEGRAM_OWNER_CHAT_ID: "-1001234567" } });

  assert.deepEqual(result.calls.map((call) => call.kind), ["sendMessage"]);
  assert.equal(result.calls[0].body.chat_id, "-1001234567");
  assert.equal(result.status, 201);
});

// --- 2. fallback still works ---------------------------------------------

test("without a configured chat id the username/getUpdates fallback still resolves", async () => {
  const result = await relay({
    env: { TELEGRAM_OWNER_USERNAME: "kruger79" },
    backlog: [privateMessage("someone_else", 1), privateMessage("kruger79")],
  });

  assert.deepEqual(result.calls.map((call) => call.kind), ["getUpdates", "sendMessage"]);
  assert.equal(result.calls[1].body.chat_id, String(BACKLOG_CHAT_ID));
  assert.equal(result.status, 201);
});

test("an empty backlog with no configured chat id still reports no-chat-id", async () => {
  const result = await relay({ env: { TELEGRAM_OWNER_USERNAME: "kruger79" }, backlog: [] });

  assert.deepEqual(result.calls.map((call) => call.kind), ["getUpdates"]);
  assert.equal(result.status, 503);
  assert.equal(result.body.reason, "no-chat-id");
  assert.equal(result.body.needsStart, true);
});

// --- 3. malformed configured chat id --------------------------------------

for (const malformed of ["", "abc", "12", "55 000", "555000x", "@kruger79", "1e5"]) {
  test(`a malformed chat id (${JSON.stringify(malformed)}) falls back to username resolution`, async () => {
    const result = await relay({
      env: { TELEGRAM_OWNER_CHAT_ID: malformed, TELEGRAM_OWNER_USERNAME: "kruger79" },
      backlog: [privateMessage("kruger79")],
    });

    assert.deepEqual(result.calls.map((call) => call.kind), ["getUpdates", "sendMessage"]);
    assert.equal(result.calls[1].body.chat_id, String(BACKLOG_CHAT_ID));
    assert.equal(result.status, 201);
  });
}

// --- 4. the configured id survives what broke the fallback ----------------

test("a configured chat id delivers with no username set and an empty backlog", async () => {
  const result = await relay({
    env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID, TELEGRAM_OWNER_USERNAME: undefined },
    backlog: [],
  });

  assert.deepEqual(result.calls.map((call) => call.kind), ["sendMessage"]);
  assert.equal(result.calls[0].body.chat_id, CONFIGURED_CHAT_ID);
  assert.equal(result.status, 201);
});

// --- 5. auth and request semantics are unchanged ---------------------------

test("a non-POST request is refused with 405", async () => {
  const result = await relay({}, { method: "GET" });
  assert.equal(result.status, 405);
  assert.equal(result.calls.length, 0);
});

test("a wrong relay secret is rejected with 401 auth-rejected", async () => {
  const result = await relay(
    { env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID } },
    { secret: "w".repeat(40) },
  );

  assert.equal(result.status, 401);
  assert.equal(result.body.reason, "auth-rejected");
  assert.equal(result.calls.length, 0, "no Telegram call on rejected auth");
});

test("a missing authorization header is rejected with 401", async () => {
  const result = await relay({ env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID } }, { secret: null });
  assert.equal(result.status, 401);
  assert.equal(result.body.reason, "auth-rejected");
});

test("a relay secret shorter than 32 characters rejects every request", async () => {
  const result = await relay(
    { relaySecret: "short", env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID } },
    { secret: "short" },
  );

  assert.equal(result.status, 401, "a matching but too-short secret must not authorise");
  assert.equal(result.body.reason, "auth-rejected");
});

test("a malformed bot token is refused with 503 token-invalid", async () => {
  const result = await relay(
    { env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID } },
    { token: "not-a-token" },
  );

  assert.equal(result.status, 503);
  assert.equal(result.body.reason, "token-invalid");
  assert.equal(result.calls.length, 0);
});

test("an empty message text is refused with 400 bad-request", async () => {
  const result = await relay(
    { env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID } },
    { body: { text: "   " } },
  );

  assert.equal(result.status, 400);
  assert.equal(result.body.reason, "bad-request");
  assert.equal(result.calls.length, 0);
});

test("a rejected sendMessage reports 502 telegram-rejected", async () => {
  const result = await relay({
    env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID },
    sendOk: false,
  });

  assert.equal(result.status, 502);
  assert.equal(result.body.reason, "telegram-rejected");
});

test("a rejected getUpdates reports 502 telegram-rejected", async () => {
  const result = await relay({ env: { TELEGRAM_OWNER_USERNAME: "kruger79" }, updatesOk: false });

  assert.equal(result.status, 502);
  assert.equal(result.body.reason, "telegram-rejected");
});

test("a timed-out Telegram request reports 502 telegram-timeout", async () => {
  const result = await relay({ env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID }, throws: true });

  assert.equal(result.status, 502);
  assert.equal(result.body.reason, "telegram-timeout");
});

test("every failure carries one of the documented reason labels", async () => {
  const labels = new Set([
    "auth-rejected",
    "token-invalid",
    "bad-request",
    "telegram-rejected",
    "no-chat-id",
    "telegram-timeout",
  ]);

  const failures = [
    await relay({}, { secret: "w".repeat(40) }),
    await relay({}, { token: "nope" }),
    await relay({ env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID } }, { body: { text: "" } }),
    await relay({ env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID }, sendOk: false }),
    await relay({ env: { TELEGRAM_OWNER_USERNAME: "kruger79" }, backlog: [] }),
    await relay({ env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID }, throws: true }),
  ];

  for (const failure of failures) {
    assert.ok(labels.has(failure.body.reason), `unexpected reason ${failure.body.reason}`);
    assert.equal(failure.body.ok, false);
  }
});

// --- 6. logs never carry secrets ------------------------------------------

test("no failure path logs the bot token or the relay secret", async () => {
  const runs = [
    await relay({}, { secret: "w".repeat(40) }),
    await relay({}, { token: "nope" }),
    await relay({ env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID } }, { body: { text: "" } }),
    await relay({ env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID }, sendOk: false }),
    await relay({ env: { TELEGRAM_OWNER_USERNAME: "kruger79" }, updatesOk: false }),
    await relay({ env: { TELEGRAM_OWNER_USERNAME: "kruger79" }, backlog: [] }),
    await relay({ env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID }, throws: true }),
  ];

  for (const run of runs) {
    assert.ok(run.logs.length > 0, "every failure path must log something");
    const logged = run.logs.join("\n");
    for (const secret of [BOT_TOKEN, RELAY_SECRET, "анкета"]) {
      assert.ok(!logged.includes(secret), `relay log leaked ${secret.slice(0, 10)}…`);
    }
  }
});

test("the success path logs nothing at all", async () => {
  const result = await relay({ env: { TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID } });

  assert.equal(result.status, 201);
  assert.deepEqual(result.logs, []);
});

// --- the application's own transport order --------------------------------
//
// Production reported "submission stored but not delivered to owner
// (request-failed)" after the transport moved from lib/telegram.ts into
// lib/telegram.mjs. `request-failed` is reachable only from the direct
// Telegram call, so these pin what the extraction had to preserve: the three
// relay variables are still read, and the relay is still tried first.

import { sendOwnerMessage } from "../lib/telegram.mjs";

const APP_RELAY_URL = "https://relay.example/api/telegram-relay";

async function withOrderedFetch(behaviour, body) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://relay.example") && !url.includes("api.telegram.org")) {
      return original(input, init);
    }
    const kind = url.startsWith("https://relay.example") ? "relay" : "direct";
    seen.push({ kind, headers: init?.headers ?? {} });
    if (kind === "relay") {
      if (behaviour === "relay-delivers") return new Response(JSON.stringify({ ok: true }), { status: 201 });
      return new Response(JSON.stringify({ ok: false, reason: "no-chat-id" }), { status: 503 });
    }
    throw new Error("network is down");
  };
  try {
    return await body(seen);
  } finally {
    globalThis.fetch = original;
  }
}

const appEnv = (extra = {}) => ({
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_OWNER_CHAT_ID: CONFIGURED_CHAT_ID,
  TELEGRAM_RELAY_URL: APP_RELAY_URL,
  TELEGRAM_RELAY_SECRET: RELAY_SECRET,
  ...extra,
});

test("the relay is tried before the direct Telegram API", async () => {
  await withOrderedFetch("relay-delivers", async (seen) => {
    const delivery = await sendOwnerMessage(appEnv(), "анкета", "[test]");

    assert.deepEqual(delivery, { ok: true, via: "relay" });
    assert.deepEqual(seen.map((call) => call.kind), ["relay"], "a working relay ends the attempt");
  });
});

test("all three relay variables are still read by the .mjs transport", async () => {
  await withOrderedFetch("relay-delivers", async (seen) => {
    await sendOwnerMessage(appEnv({ TELEGRAM_RELAY_AUTH_TOKEN: "deployment-bypass" }), "анкета", "[test]");

    const [relayCall] = seen;
    assert.equal(relayCall.headers.authorization, `Bearer ${RELAY_SECRET}`, "TELEGRAM_RELAY_SECRET");
    assert.equal(relayCall.headers["x-telegram-bot-token"], BOT_TOKEN, "TELEGRAM_BOT_TOKEN");
    assert.equal(
      relayCall.headers["OAI-Sites-Authorization"],
      "Bearer deployment-bypass",
      "TELEGRAM_RELAY_AUTH_TOKEN",
    );
  });
});

test("a failing relay falls through to direct, in that order", async () => {
  await withOrderedFetch("relay-refuses", async (seen) => {
    const delivery = await sendOwnerMessage(appEnv(), "анкета", "[test]");

    assert.deepEqual(seen.map((call) => call.kind), ["relay", "direct"], "relay first, direct second");
    assert.deepEqual(delivery, { ok: false, reason: "request-failed" });
  });
});

test("an unconfigured relay is reported instead of silently skipped", async () => {
  // The state behind the production report: with no https URL or a secret
  // under 32 characters the relay is skipped, and until now that left no
  // trace at all — the log showed only the direct call's request-failed.
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.map(String).join(" "));
  try {
    await withOrderedFetch("relay-delivers", async (seen) => {
      const delivery = await sendOwnerMessage(
        appEnv({ TELEGRAM_RELAY_URL: undefined, TELEGRAM_RELAY_SECRET: undefined }),
        "анкета",
        "[test]",
      );

      assert.deepEqual(seen.map((call) => call.kind), ["direct"], "the relay is never called");
      assert.deepEqual(delivery, { ok: false, reason: "request-failed" });
    });
    assert.ok(
      logs.some((line) => line.includes("telegram relay is not configured")),
      "the skipped relay must be visible in the log",
    );
    for (const line of logs) assert.ok(!line.includes(RELAY_SECRET) && !line.includes(BOT_TOKEN));
  } finally {
    console.error = originalError;
  }
});

test("a too-short relay secret is treated as unconfigured, not sent", async () => {
  await withOrderedFetch("relay-delivers", async (seen) => {
    await sendOwnerMessage(appEnv({ TELEGRAM_RELAY_SECRET: "short" }), "анкета", "[test]");
    assert.deepEqual(seen.map((call) => call.kind), ["direct"], "a short secret must not be sent");
  });
});
