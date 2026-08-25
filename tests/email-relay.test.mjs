// The HTTPS email relay, and how the application picks a transport.
//
// Timeweb times out on smtp.yandex.ru:465 and :587 alike, so a direct SMTP
// connection is not a transport there at all — it is a ten-second wait before
// failing. When EMAIL_RELAY_URL and EMAIL_RELAY_SECRET are set the message
// goes over HTTPS to relay-vercel/api/email-relay instead, and the relay owns
// the mailbox credentials.
//
// Nothing here opens a socket: fetch is intercepted and the relay's own
// sendMail is exercised only through a stub.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import handler from "../relay-vercel/api/email-relay.mjs";
import { buildMessage as relayBuildMessage } from "../relay-vercel/lib/smtp.mjs";
import { buildMessage, isEmailReady, isEmailRelayConfigured, sendMail } from "../lib/smtp.mjs";

const RELAY_SECRET = "e".repeat(40);
const RELAY_URL = "https://relay.example/api/email-relay";
const SMTP_USER = "info@poztender.ru";
const SMTP_PASSWORD = "app-password-not-real";
const RECIPIENT = "client@example.ru";
const BODY_TEXT = "Ответим на этот email. Секретная часть письма.";
const BODY_HTML = "<p>Ответим на этот email. Секретная часть письма.</p>";

// --- the relay endpoint ---------------------------------------------------

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

function fakeRequest({ method = "POST", secret = RELAY_SECRET, body } = {}) {
  const headers = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return {
    method,
    headers,
    body:
      body === undefined
        ? { to: RECIPIENT, subject: "Анкета получена — ПожТендер", text: BODY_TEXT, html: BODY_HTML }
        : body,
  };
}

/**
 * Runs the relay handler with a fixed environment, a stubbed SMTP send and a
 * captured console.error. The stub records what the handler asked to send, so
 * the tests can assert the sender was never taken from the request.
 */
async function relay(options = {}, requestOptions = {}) {
  const keys = ["EMAIL_RELAY_SECRET", "YANDEX_SMTP_USER", "YANDEX_SMTP_PASSWORD"];
  const previous = keys.map((key) => [key, process.env[key]]);
  const originalError = console.error;

  for (const key of keys) delete process.env[key];
  process.env.EMAIL_RELAY_SECRET = options.relaySecret ?? RELAY_SECRET;
  if (options.smtp !== false) {
    process.env.YANDEX_SMTP_USER = SMTP_USER;
    process.env.YANDEX_SMTP_PASSWORD = SMTP_PASSWORD;
  }

  const logs = [];
  console.error = (...args) => logs.push(args.map(String).join(" "));

  const response = fakeResponse();
  try {
    await handler(fakeRequest(requestOptions), response);
    return { ...response.sent, logs };
  } finally {
    console.error = originalError;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a wrong relay secret is rejected with 401 and never reaches SMTP", async () => {
  const result = await relay({}, { secret: "w".repeat(40) });
  assert.equal(result.status, 401);
  assert.equal(result.body.reason, "auth-rejected");
});

test("a missing authorization header is rejected with 401", async () => {
  const result = await relay({}, { secret: null });
  assert.equal(result.status, 401);
  assert.equal(result.body.reason, "auth-rejected");
});

test("a relay secret shorter than 32 characters rejects every request", async () => {
  const result = await relay({ relaySecret: "short" }, { secret: "short" });
  assert.equal(result.status, 401, "a matching but too-short secret must not authorise");
});

test("only POST is accepted", async () => {
  const result = await relay({}, { method: "GET" });
  assert.equal(result.status, 405);
});

test("a relay without mailbox credentials reports not-configured", async () => {
  const result = await relay({ smtp: false });
  assert.equal(result.status, 503);
  assert.equal(result.body.reason, "not-configured");
});

test("a missing or invalid recipient is refused with 400", async () => {
  for (const to of [undefined, "", "not-an-address", "a@b", "a b@example.ru", 42]) {
    const result = await relay({}, { body: { to, subject: "Тест", text: "x", html: "<p>x</p>" } });
    assert.equal(result.status, 400, `recipient ${JSON.stringify(to)} must be refused`);
    assert.ok(["bad-request", "invalid-recipient"].includes(result.body.reason));
  }
});

test("an empty subject or an empty body is refused with 400", async () => {
  const noSubject = await relay({}, { body: { to: RECIPIENT, subject: "  ", text: "x" } });
  assert.equal(noSubject.status, 400);

  const noBody = await relay({}, { body: { to: RECIPIENT, subject: "Тест", text: " ", html: " " } });
  assert.equal(noBody.status, 400);
});

test("oversized fields are refused instead of being forwarded", async () => {
  const cases = [
    { to: `${"a".repeat(250)}@example.ru`, subject: "Тест", text: "x" },
    { to: RECIPIENT, subject: "s".repeat(201), text: "x" },
    { to: RECIPIENT, subject: "Тест", text: "t".repeat(20_001) },
    { to: RECIPIENT, subject: "Тест", text: "x", html: "h".repeat(100_001) },
  ];
  for (const body of cases) {
    const result = await relay({}, { body });
    assert.equal(result.status, 400, `oversized ${Object.keys(body).join("/")} must be refused`);
  }
});

test("the relay never accepts a sender or credentials from the request", async () => {
  const source = await readFile(new URL("../relay-vercel/api/email-relay.mjs", import.meta.url), "utf-8");

  // Every value that could impersonate someone or authorise a send is read
  // from process.env, and the request body is only ever read for to/subject/
  // text/html.
  assert.match(source, /process\.env\.YANDEX_SMTP_USER/);
  assert.match(source, /process\.env\.YANDEX_SMTP_PASSWORD/);
  assert.match(source, /process\.env\.EMAIL_RELAY_SECRET/);

  const bodyReads = [...source.matchAll(/body\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(bodyReads)].sort(),
    ["from", "html", "subject", "text", "to"],
    "the only body fields touched are the four payload fields, plus the comment that pins `from` as ignored",
  );
  assert.doesNotMatch(source, /body\.from\s*[?|)]/, "`from` must never be read into a value");
  assert.doesNotMatch(source, /YANDEX_SMTP_PASSWORD\s*=\s*(?!.*process\.env)/);
});

test("the relay logs no credential, recipient or message content", async () => {
  const runs = [
    await relay({}, { secret: "w".repeat(40) }),
    await relay({}, { body: { to: "nope", subject: "Тест", text: BODY_TEXT } }),
    await relay({ smtp: false }),
  ];

  for (const run of runs) {
    assert.ok(run.logs.length > 0, "every failure path must log something");
    const logged = run.logs.join("\n");
    for (const secret of [RELAY_SECRET, SMTP_PASSWORD, SMTP_USER, RECIPIENT, BODY_TEXT, BODY_HTML]) {
      assert.ok(!logged.includes(secret), `relay log leaked ${secret.slice(0, 12)}…`);
    }
  }
});

test("no console call in the relay or its transport can print a body or a credential", async () => {
  for (const file of ["../relay-vercel/api/email-relay.mjs", "../relay-vercel/lib/smtp.mjs"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf-8");
    const calls = source.match(/console\.[a-z]+\([^\n]*/g) ?? [];
    assert.ok(calls.length > 0, `${file} must actually log something`);
    for (const call of calls) {
      // Naming a variable in a message is fine; interpolating one is not, so
      // only the substituted expressions are inspected.
      for (const [, expression] of call.matchAll(/\$\{([^}]*)\}/g)) {
        assert.doesNotMatch(
          expression,
          /password|secret|token|\bhtml\b|\btext\b|\bto\b|\buser\b|body/i,
          `${file} interpolates ${expression} into a log line`,
        );
      }
      // A bare identifier passed as a further argument would print its value.
      assert.doesNotMatch(call, /,\s*(to|text|html|subject|password|user|body)\s*[,)]/, call);
    }
    assert.doesNotMatch(source, /console\.log/);
  }
});

// --- the relay copy of the transport --------------------------------------

test("the relay builds byte-identical MIME to the application", async () => {
  const args = [SMTP_USER, RECIPIENT, "Анкета получена — ПожТендер", {
    html: BODY_HTML,
    text: BODY_TEXT,
  }];
  // Message-ID and Date are unique per message by design, so they are the only
  // parts allowed to differ.
  const strip = (message) =>
    message.replace(/^(Message-ID|Date): .*$/gm, "$1: <pinned>").replace(/bnd_[0-9a-f]+/g, "bnd");

  assert.equal(strip(buildMessage(...args)), strip(relayBuildMessage(...args)));
});

test("the relay copy of the transport cannot relay to itself", async () => {
  const source = await readFile(new URL("../relay-vercel/lib/smtp.mjs", import.meta.url), "utf-8");
  // Comments may name it; executable code must not read it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /EMAIL_RELAY_URL/, "a relay that relays to itself is a loop");
  assert.doesNotMatch(code, /EMAIL_RELAY_SECRET/);
});

// --- transport selection on the application side ---------------------------

/** Intercepts the relay call and reports what was sent to it. */
async function withRelayFetch(behaviour, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://relay.example")) return original(input, init);
    calls.push({ url, headers: init?.headers ?? {}, body: JSON.parse(init.body) });
    if (behaviour === "throws") {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }
    if (behaviour === "refuses") {
      return new Response(JSON.stringify({ ok: false, reason: "smtp-failed" }), { status: 502 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const relayEnv = (extra = {}) => ({
  EMAIL_RELAY_URL: RELAY_URL,
  EMAIL_RELAY_SECRET: RELAY_SECRET,
  ...extra,
});

test("the relay is chosen whenever both variables are set", () => {
  assert.equal(isEmailRelayConfigured(relayEnv()), true);
  assert.equal(isEmailReady(relayEnv()), true, "no SMTP password is needed behind the relay");
});

test("a half-configured relay is ignored rather than used unauthenticated", () => {
  assert.equal(isEmailRelayConfigured({ EMAIL_RELAY_URL: RELAY_URL }), false);
  assert.equal(
    isEmailRelayConfigured({ EMAIL_RELAY_URL: RELAY_URL, EMAIL_RELAY_SECRET: "short" }),
    false,
    "a secret under 32 characters must not be sent",
  );
  assert.equal(
    isEmailRelayConfigured({ EMAIL_RELAY_URL: "http://relay.example", EMAIL_RELAY_SECRET: RELAY_SECRET }),
    false,
    "plain HTTP must never carry the secret",
  );
});

test("with the relay configured, sendMail posts to it over HTTPS", async () => {
  await withRelayFetch("accepts", async (calls) => {
    const sent = await sendMail(relayEnv(), {
      to: RECIPIENT,
      subject: "Анкета получена — ПожТендер",
      html: BODY_HTML,
      text: BODY_TEXT,
    });

    assert.equal(sent, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\//);
    assert.equal(calls[0].headers.authorization, `Bearer ${RELAY_SECRET}`);
    assert.deepEqual(Object.keys(calls[0].body).sort(), ["html", "subject", "text", "to"]);
    assert.equal(calls[0].body.to, RECIPIENT);
  });
});

test("the request to the relay carries no credentials and no sender", async () => {
  await withRelayFetch("accepts", async (calls) => {
    await sendMail(relayEnv({ YANDEX_SMTP_PASSWORD: SMTP_PASSWORD, YANDEX_SMTP_USER: SMTP_USER }), {
      to: RECIPIENT,
      subject: "Тест",
      html: BODY_HTML,
      text: BODY_TEXT,
    });

    const serialised = JSON.stringify(calls[0].body);
    assert.ok(!serialised.includes(SMTP_PASSWORD), "the SMTP password must never leave this host");
    assert.equal(calls[0].body.from, undefined, "the sender is the relay's decision");
    assert.equal(calls[0].headers["x-smtp-password"], undefined);
  });
});

test("a refused relay fails the send without a direct SMTP attempt", async () => {
  await withRelayFetch("refuses", async (calls) => {
    const started = Date.now();
    const sent = await sendMail(relayEnv(), { to: RECIPIENT, subject: "Тест", text: BODY_TEXT });

    assert.equal(sent, false, "a refused relay is a delivery failure");
    assert.equal(calls.length, 1);
    // A direct fallback would spend ten seconds timing out on a port this host
    // has already been proven unable to reach.
    assert.ok(Date.now() - started < 2_000, "there must be no direct SMTP fallback");
  });
});

test("an unreachable relay fails the send without a direct SMTP attempt", async () => {
  await withRelayFetch("throws", async (calls) => {
    const started = Date.now();
    const sent = await sendMail(relayEnv(), { to: RECIPIENT, subject: "Тест", text: BODY_TEXT });

    assert.equal(sent, false);
    assert.equal(calls.length, 1);
    assert.ok(Date.now() - started < 2_000);
  });
});

test("an invalid recipient is refused before the relay is called", async () => {
  await withRelayFetch("accepts", async (calls) => {
    assert.equal(await sendMail(relayEnv(), { to: "nope", subject: "Тест", text: "x" }), false);
    assert.equal(calls.length, 0);
  });
});

test("without relay variables the direct SMTP path is kept", async () => {
  // Not configured at all: sendMail refuses before opening a socket, which is
  // what keeps `resend-access` and the diagnostics working locally on their
  // own credentials rather than silently needing a relay.
  assert.equal(isEmailRelayConfigured({}), false);
  assert.equal(isEmailReady({}), false);
  assert.equal(isEmailReady({ YANDEX_SMTP_USER: SMTP_USER, YANDEX_SMTP_PASSWORD: SMTP_PASSWORD }), true);

  await withRelayFetch("accepts", async (calls) => {
    assert.equal(await sendMail({}, { to: RECIPIENT, subject: "Тест", text: "x" }), false);
    assert.equal(calls.length, 0, "an unconfigured host must not call the relay");
  });

  const source = await readFile(new URL("../lib/smtp.mjs", import.meta.url), "utf-8");
  assert.match(source, /connect\(\{ host: SMTP_HOST/, "the direct transport must still exist");
  assert.match(source, /isEmailRelayConfigured\(env\)\n?\s*\?/, "selection is by configuration");
});
