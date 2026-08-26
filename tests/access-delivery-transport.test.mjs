// Which transports the administrative scripts consider "configured".
//
// deliverAccessEmail used to run its own preflight —
//
//   if (!env.YANDEX_SMTP_USER || !env.YANDEX_SMTP_PASSWORD) return "not-configured";
//
// — which was written before mail moved to the HTTPS relay. A host behind the
// relay holds no SMTP password by design, so `resend-access` reported
// "not-configured" on exactly the deployment that works, and the operator was
// told to set credentials that must not be there. The preflight now shares
// isEmailReady() with the app, so it cannot fall behind sendMail's transports
// again.
//
// Nothing here opens a socket or touches a database: fetch is intercepted and
// the pg client is a stub that records the SQL it was asked to run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deliverAccessEmail } from "../scripts/lib/access-delivery.mjs";
import { isEmailReady } from "../lib/smtp.mjs";

const RELAY_URL = "https://relay.example/api/email-relay";
const RELAY_SECRET = "e".repeat(40);
const SMTP_USER = "info@poztender.ru";
const SMTP_PASSWORD = "app-password-not-real";

const RELAY_ONLY = { EMAIL_RELAY_URL: RELAY_URL, EMAIL_RELAY_SECRET: RELAY_SECRET };
const SMTP_ONLY = { YANDEX_SMTP_USER: SMTP_USER, YANDEX_SMTP_PASSWORD: SMTP_PASSWORD };

const ORDER = {
  id: 1,
  invoice_id: "412040522831714",
  plan: "pilot",
  status: "paid",
  email: "buyer@example.ru",
  expected_amount: "4900.00",
};

/** A pg client that answers the grant lookup and records every statement. */
function fakeClient({ validUntil = new Date(Date.now() + 7 * 86_400_000) } = {}) {
  const statements = [];
  return {
    statements,
    async query(text, params) {
      statements.push({ text: text.trim().split("\n")[0], params });
      if (/FROM access_grants/.test(text)) {
        return { rows: [{ valid_until: validUntil.toISOString(), revoked_at: null }] };
      }
      return { rows: [] };
    },
  };
}

const ENV_KEYS = [
  "EMAIL_RELAY_URL",
  "EMAIL_RELAY_SECRET",
  "YANDEX_SMTP_USER",
  "YANDEX_SMTP_PASSWORD",
];

/**
 * Runs deliverAccessEmail under a fixed environment with the relay call
 * intercepted. Any attempt to reach anything else is refused loudly rather
 * than silently going to the network.
 */
async function deliver(env, { relay = "accepts" } = {}) {
  const previous = ENV_KEYS.map((key) => [key, process.env[key]]);
  const originalFetch = globalThis.fetch;

  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://relay.example")) {
      throw new Error(`unexpected outbound request to ${url}`);
    }
    calls.push({ url, headers: init?.headers ?? {}, body: JSON.parse(init.body) });
    return relay === "accepts"
      ? new Response(JSON.stringify({ ok: true }), { status: 201 })
      : new Response(JSON.stringify({ ok: false, reason: "smtp-failed" }), { status: 502 });
  };

  const client = fakeClient();
  try {
    const outcome = await deliverAccessEmail(client, ORDER, "https://poztender.ru");
    return { outcome, calls, statements: client.statements };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// --- what counts as configured -------------------------------------------

test("a relay-only environment is configured", () => {
  assert.equal(isEmailReady(RELAY_ONLY), true);
});

test("a direct-SMTP-only environment is configured", () => {
  assert.equal(isEmailReady(SMTP_ONLY), true);
});

test("an empty environment is not configured", () => {
  assert.equal(isEmailReady({}), false);
});

test("half a relay is not configured", () => {
  assert.equal(isEmailReady({ EMAIL_RELAY_URL: RELAY_URL }), false);
  assert.equal(isEmailReady({ EMAIL_RELAY_SECRET: RELAY_SECRET }), false);
});

// --- the preflight in the administrative scripts ---------------------------

test("resend-access reports not-configured only when neither transport is set", async () => {
  const { outcome, calls, statements } = await deliver({});

  assert.equal(outcome, "not-configured");
  assert.equal(calls.length, 0);
  assert.equal(statements.length, 0, "no link may be minted when nothing can send it");
});

test("with the relay alone, resend-access sends over HTTPS", async () => {
  const { outcome, calls } = await deliver(RELAY_ONLY);

  assert.equal(outcome, "sent", "the relay-only host must not report not-configured");
  assert.equal(calls.length, 1, "the HTTPS relay was actually called");
  assert.match(calls[0].url, /^https:\/\//);
  assert.equal(calls[0].headers.authorization, `Bearer ${RELAY_SECRET}`);
  assert.equal(calls[0].body.to, ORDER.email);
  assert.match(calls[0].body.subject, /412040522831714/);
});

test("no Yandex credentials are needed behind the relay", async () => {
  const { outcome, calls } = await deliver(RELAY_ONLY);

  assert.equal(process.env.YANDEX_SMTP_USER, undefined);
  assert.equal(process.env.YANDEX_SMTP_PASSWORD, undefined);
  assert.equal(outcome, "sent");

  // And nothing about the mailbox leaves this host: the relay owns the sender.
  const serialised = JSON.stringify(calls[0].body);
  assert.ok(!serialised.includes(SMTP_PASSWORD));
  assert.equal(calls[0].body.from, undefined);
});

test("the access link is recorded as sent only after the relay accepted it", async () => {
  const sent = await deliver(RELAY_ONLY);
  assert.ok(
    sent.statements.some((statement) => /UPDATE access_links SET sent_at/.test(statement.text)),
    "a delivered link is stamped",
  );

  const refused = await deliver(RELAY_ONLY, { relay: "refuses" });
  assert.equal(refused.outcome, "failed");
  assert.ok(
    !refused.statements.some((statement) => /UPDATE access_links SET sent_at/.test(statement.text)),
    "a refused delivery must not claim the link was sent",
  );
});

test("a refused relay never falls back to a direct SMTP connection", async () => {
  // The fetch stub throws on any host but the relay, so a fallback attempt
  // would surface as an unexpected-request error rather than a quiet timeout.
  const { outcome, calls } = await deliver({ ...RELAY_ONLY, ...SMTP_ONLY }, { relay: "refuses" });

  assert.equal(outcome, "failed");
  assert.equal(calls.length, 1, "exactly one attempt, over the relay");
});

// --- the two preflights stay in step --------------------------------------

test("no administrative script keeps its own transport check", async () => {
  for (const file of ["../scripts/lib/access-delivery.mjs", "../scripts/lib/intake-delivery.mjs"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf-8");
    assert.match(source, /isEmailReady/, `${file} must share the app's readiness check`);
    assert.doesNotMatch(
      source,
      /!env\.YANDEX_SMTP_USER|!process\.env\.YANDEX_SMTP_USER/,
      `${file} must not test the Yandex credentials directly`,
    );
  }
});

test("the operator message names both transports, not just Yandex", async () => {
  const source = await readFile(new URL("../scripts/resend-access.mjs", import.meta.url), "utf-8");
  const message = /throw new OperatorError\(\s*\n?\s*"email delivery is not configured[\s\S]*?\);/.exec(source);

  assert.ok(message, "the not-configured branch must explain both transports");
  assert.match(message[0], /EMAIL_RELAY_URL/);
  assert.match(message[0], /EMAIL_RELAY_SECRET/);
});
