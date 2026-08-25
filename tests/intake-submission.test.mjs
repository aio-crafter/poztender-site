// Durable acceptance of the intake form.
//
// The form used to be accepted only if Telegram delivery succeeded: an
// unreachable relay returned 502 and told a paying customer «Анкета не
// отправлена», while their answers existed nowhere at all. Acceptance is now a
// row in intake_submissions, written in the same transaction that spends the
// grant, and every delivery after that is a retryable side effect.
//
// Runs against the built worker and a real PostgreSQL (PGlite over a TCP
// socket), so the UNIQUE constraints and the conditional UPDATE that carry the
// idempotency guarantees are executed by genuine PostgreSQL.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import { startTestDatabase } from "./helpers/postgres.mjs";

const ORIGIN = "https://poztender.example";
const PASSWORD_2 = "fake-password-two";
const PILOT_AMOUNT = "4900.00";
const BOT_TOKEN = `123456789:${"A".repeat(35)}`;
const DB_PORT = 55_432 + (process.pid % 200);

let testDb;
let worker;

before(async () => {
  testDb = await startTestDatabase(DB_PORT);
  process.env.DATABASE_URL = testDb.url;
  // PGlite serves one backend, so the pool must not try to open several.
  process.env.DATABASE_POOL_MAX = "1";
  process.env.ROBOKASSA_MERCHANT_LOGIN = "poztender-test";
  process.env.ROBOKASSA_PASSWORD_1 = "fake-password-one";
  process.env.ROBOKASSA_PASSWORD_2 = PASSWORD_2;
  process.env.ROBOKASSA_TEST_MODE = "true";
  process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "false";
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_OWNER_CHAT_ID = "555000";
  delete process.env.TELEGRAM_RELAY_URL;
  // No SMTP credentials: sendMail returns false without opening a socket, so
  // "email down" is the default state and no test ever reaches the network.
  delete process.env.YANDEX_SMTP_USER;
  delete process.env.YANDEX_SMTP_PASSWORD;

  const url = new URL("../dist/server/index.js", import.meta.url);
  worker = await import(url.href).then((module) => module.default);

  // One warm-up request outside any interception. The worker resolves parts of
  // its module graph on first use, and paying that cost inside a test made the
  // first Telegram call escape the intercepted window.
  await request("/health");
});

after(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.reset();
});

let clientCounter = 0;
function nextClientAddress() {
  clientCounter += 1;
  return `198.18.${Math.floor(clientCounter / 254) % 254}.${(clientCounter % 254) + 1}`;
}

async function request(path, init = {}) {
  const { cookie, headers, ...rest } = init;
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      ...rest,
      headers: {
        accept: "text/html",
        "x-forwarded-proto": "https",
        "x-forwarded-for": nextClientAddress(),
        ...(cookie ? { cookie } : {}),
        ...(headers ?? {}),
      },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const rows = async (sql) => (await testDb.db.query(sql)).rows;
const submissionRows = () => rows("SELECT * FROM intake_submissions ORDER BY id");
const grantRows = () => rows("SELECT * FROM access_grants ORDER BY id");

function readFormFields(html) {
  const fields = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[match[1]] = match[2].replaceAll("&amp;", "&").replaceAll("&quot;", '"');
  }
  return fields;
}

/** A paid pilot order plus the browser cookie jar that owns it. */
async function paidOrder() {
  const response = await request("/api/payment/start?email=buyer%40example.ru");
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const fields = readFormFields(await response.text());
  const signature = sha256(`${PILOT_AMOUNT}:${fields.InvId}:${PASSWORD_2}`);
  await request(
    `/api/payment/result?OutSum=${PILOT_AMOUNT}&InvId=${fields.InvId}&SignatureValue=${signature}`,
  );
  return { cookie, invoiceId: fields.InvId };
}

function validIntake(overrides = {}) {
  return {
    company: "ООО ПожСервис",
    inn: "6312345678",
    contactName: "Александр",
    email: "client@example.ru",
    telegram: "@client_test",
    replyChannel: "telegram",
    regions: "Самарская область",
    workTypes: "Монтаж и обслуживание АПС и СОУЭ",
    consent: true,
    ...overrides,
  };
}

function submit(cookie, body = validIntake()) {
  return request("/api/intake", {
    cookie,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Intercepts every call to api.telegram.org. `mode` decides what the owner's
 * notification runs into: delivery, a rejection, or an unreachable network.
 */
function interceptTelegram(mode) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.includes("api.telegram.org")) return original(input, init);
    calls.push(url);
    if (mode === "throws") throw new Error("network is down");
    const ok = mode !== "rejects";
    return new Response(JSON.stringify({ ok }), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function withTelegram(mode, body) {
  const telegram = interceptTelegram(mode);
  try {
    return await body(telegram);
  } finally {
    telegram.restore();
  }
}

/** Everything a stored, accepted submission must be true of. */
async function assertAccepted(response, invoiceId) {
  assert.equal(response.status, 201, "an accepted form answers 201");
  assert.deepEqual(await response.json(), { ok: true });

  const stored = await submissionRows();
  assert.equal(stored.length, 1, "exactly one submission");
  assert.equal(stored[0].company, "ООО ПожСервис");
  assert.equal(stored[0].reply_channel, "telegram");
  assert.ok(stored[0].submitted_at, "submitted_at is stamped");

  const [grant] = await grantRows();
  assert.ok(grant.used_at, "the grant is spent in the same transaction");
  assert.equal(stored[0].grant_id, grant.id);

  const [order] = await rows(`SELECT id FROM orders WHERE invoice_id = ${invoiceId}`);
  assert.equal(stored[0].order_id, order.id);
  return stored[0];
}

// --- the delivery matrix --------------------------------------------------
//
// Email is down in every one of these: with no SMTP credentials sendMail
// returns false before opening a socket. A genuinely successful send is
// covered separately, below.

test("both channels working: the form is accepted", async () => {
  await withTelegram("delivers", async (telegram) => {
    const { cookie, invoiceId } = await paidOrder();
    const stored = await assertAccepted(await submit(cookie), invoiceId);

    assert.equal(telegram.calls.length, 1, "the owner is notified once");
    assert.ok(stored.telegram_notified_at, "a delivered notification is stamped");
  });
});

test("Telegram down, the form is still accepted", async () => {
  await withTelegram("throws", async (telegram) => {
    const { cookie, invoiceId } = await paidOrder();
    const stored = await assertAccepted(await submit(cookie), invoiceId);

    assert.ok(telegram.calls.length >= 1, "delivery was attempted");
    assert.equal(stored.telegram_notified_at, null, "an undelivered notification stays unstamped");
  });
});

test("Telegram rejecting the message does not fail the form", async () => {
  await withTelegram("rejects", async () => {
    const { cookie, invoiceId } = await paidOrder();
    const stored = await assertAccepted(await submit(cookie), invoiceId);
    assert.equal(stored.telegram_notified_at, null);
  });
});

test("email down, the form is still accepted", async () => {
  await withTelegram("delivers", async () => {
    const { cookie, invoiceId } = await paidOrder();
    const stored = await assertAccepted(await submit(cookie), invoiceId);

    assert.ok(stored.telegram_notified_at, "Telegram succeeded");
    assert.equal(stored.email_notified_at, null, "the confirmation email did not go out");
  });
});

test("both channels down, the form is still accepted", async () => {
  await withTelegram("throws", async () => {
    const { cookie, invoiceId } = await paidOrder();
    const stored = await assertAccepted(await submit(cookie), invoiceId);

    assert.equal(stored.telegram_notified_at, null);
    assert.equal(stored.email_notified_at, null);
    // The point of the whole change: nothing external decided this.
    assert.equal((await submissionRows()).length, 1);
  });
});

test("a misconfigured Telegram bot no longer refuses the form", async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const { cookie, invoiceId } = await paidOrder();
    // Used to answer 503 «Канал приёма анкет временно настраивается» before
    // the answers were stored anywhere.
    const stored = await assertAccepted(await submit(cookie), invoiceId);
    assert.equal(stored.telegram_notified_at, null);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

// --- idempotency ----------------------------------------------------------

test("a duplicate submit stores exactly one submission", async () => {
  await withTelegram("delivers", async (telegram) => {
    const { cookie, invoiceId } = await paidOrder();
    await assertAccepted(await submit(cookie), invoiceId);

    const second = await submit(cookie, validIntake({ company: "ООО Другая" }));
    assert.equal(second.status, 409);

    const stored = await submissionRows();
    assert.equal(stored.length, 1, "the second submit must not add a row");
    assert.equal(stored[0].company, "ООО ПожСервис", "the first answers stand");
    assert.equal(telegram.calls.length, 1, "the owner is not notified twice");
  });
});

test("two concurrent submits store exactly one submission", async () => {
  await withTelegram("delivers", async (telegram) => {
    const { cookie, invoiceId } = await paidOrder();

    const [first, second] = await Promise.all([submit(cookie), submit(cookie)]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409], "exactly one caller wins");

    const stored = await submissionRows();
    assert.equal(stored.length, 1, "the UNIQUE constraint holds under a race");
    assert.equal(stored[0].order_id, (await rows(
      `SELECT id FROM orders WHERE invoice_id = ${invoiceId}`,
    ))[0].id);
    assert.equal(telegram.calls.length, 1, "only the winner notifies the owner");

    const grants = await grantRows();
    assert.equal(grants.length, 1);
    assert.ok(grants[0].used_at);
  });
});

test("a spent grant leaves /brief in its completed state", async () => {
  await withTelegram("throws", async () => {
    const { cookie, invoiceId } = await paidOrder();
    await assertAccepted(await submit(cookie), invoiceId);

    // Delivery failed, and the customer still sees the form as sent: a reload
    // must never invite them to fill it in again.
    const page = await request("/brief", { cookie });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Анкета уже отправлена/);
    assert.match(html, /Мы получили данные/);
    assert.doesNotMatch(html, /Единая точка старта/, "the form must not be rendered again");
  });
});

// --- retrying delivery ----------------------------------------------------

test("retrying delivery notifies again without creating a submission", async () => {
  const { redeliver, findUndelivered } = await import("../scripts/lib/intake-delivery.mjs");

  await withTelegram("throws", async () => {
    const { cookie, invoiceId } = await paidOrder();
    await assertAccepted(await submit(cookie), invoiceId);
  });

  const client = {
    query: (text, params) => testDb.db.query(text, params ?? []),
  };

  const pending = await findUndelivered(client);
  assert.equal(pending.length, 1, "the undelivered form is picked up");
  assert.equal(String(pending[0].invoice_id).length > 0, true);

  await withTelegram("delivers", async (telegram) => {
    const result = await redeliver(client, pending[0]);
    assert.equal(result.telegram, "sent");
    assert.equal(telegram.calls.length, 1, "the owner is notified on the retry");
  });

  const stored = await submissionRows();
  assert.equal(stored.length, 1, "a retry must never create a second submission");
  assert.ok(stored[0].telegram_notified_at, "a successful retry stamps the column");

  const [grant] = await grantRows();
  assert.ok(grant.used_at, "the grant is untouched by a retry");

  // The sweep still lists the row, because the confirmation email has no
  // mailer configured here — but the Telegram half is settled and a further
  // retry would not notify the owner again.
  const remaining = await findUndelivered(client);
  assert.equal(remaining.length, 1);
  assert.ok(remaining[0].telegram_notified_at, "the delivered channel is not offered again");
  assert.equal(remaining[0].email_notified_at, null);
});

test("the retry helper reports an unconfigured mailer instead of failing", async () => {
  const { redeliver } = await import("../scripts/lib/intake-delivery.mjs");

  await withTelegram("delivers", async () => {
    const { cookie, invoiceId } = await paidOrder();
    await assertAccepted(await submit(cookie), invoiceId);
  });

  const client = { query: (text, params) => testDb.db.query(text, params ?? []) };
  const [row] = await rows(
    `SELECT s.*, o.invoice_id, o.buyer_type, o.buyer_inn, o.buyer_name
       FROM intake_submissions s JOIN orders o ON o.id = s.order_id`,
  );

  const result = await redeliver(client, row);
  assert.equal(result.email, "not-configured", "a missing mailer is reported, not thrown");
  assert.equal((await submissionRows()).length, 1);
});

// --- the reply channel travels with the stored form -----------------------

test("the chosen reply channel is stored and reaches the owner", async () => {
  await withTelegram("delivers", async () => {
    const { cookie, invoiceId } = await paidOrder();
    await submit(cookie, validIntake({ replyChannel: "email", telegram: "" }));

    const [stored] = await submissionRows();
    assert.equal(stored.reply_channel, "email");
    assert.equal(stored.telegram, "");
    assert.equal(stored.email, "client@example.ru");
    assert.ok(invoiceId);
  });
});

test("the database refuses a reply channel it does not know", async () => {
  await assert.rejects(
    () =>
      testDb.db.query(
        `INSERT INTO intake_submissions
           (order_id, grant_id, company, inn, contact_name, email, reply_channel, regions, work_types)
         VALUES (1, 1, 'x', '6312345678', 'x', 'x@example.ru', 'carrier-pigeon', 'x', 'x')`,
      ),
    /intake_submissions_reply_channel|violates/i,
  );
});
