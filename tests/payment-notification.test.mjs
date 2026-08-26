// The owner's Telegram notification for a confirmed card payment.
//
// It is sent from the ResultURL handler, after confirmPayment's transaction has
// committed and only on the "confirmed" branch. That branch is reached by
// exactly one caller — the conditional UPDATE inside the transaction lets one
// win and returns "already-paid" to everyone else — so a Robokassa retry can
// never produce a second message. Nothing about the notification may change
// whether the order is paid, whether a grant exists, or what Robokassa is told.
//
// Runs against the built worker and a real PostgreSQL (PGlite over a TCP
// socket). No message leaves the machine: fetch is intercepted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before, beforeEach } from "node:test";
import { startTestDatabase } from "./helpers/postgres.mjs";
import { createPaymentNotification } from "../lib/intake-notification.mjs";

const ORIGIN = "https://poztender.example";
const PASSWORD_1 = "fake-password-one";
const PASSWORD_2 = "fake-password-two";
const PILOT_AMOUNT = "4900.00";
const SUBSCRIPTION_AMOUNT = "7900.00";
const BOT_TOKEN = `123456789:${"A".repeat(35)}`;
const ORG_INN = "7707083893";
// Its own port band — see the note in tests/intake-submission.test.mjs.
const DB_PORT = 56_900 + (process.pid % 200);

let testDb;
let worker;

before(async () => {
  testDb = await startTestDatabase(DB_PORT);
  process.env.DATABASE_URL = testDb.url;
  process.env.DATABASE_POOL_MAX = "1";
  process.env.ROBOKASSA_MERCHANT_LOGIN = "poztender-test";
  process.env.ROBOKASSA_PASSWORD_1 = PASSWORD_1;
  process.env.ROBOKASSA_PASSWORD_2 = PASSWORD_2;
  process.env.ROBOKASSA_TEST_MODE = "true";
  process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "false";
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_OWNER_CHAT_ID = "555000";
  delete process.env.TELEGRAM_RELAY_URL;
  // No mailer: the access email returns false without opening a socket, so
  // these tests exercise the notification and nothing else.
  delete process.env.YANDEX_SMTP_USER;
  delete process.env.YANDEX_SMTP_PASSWORD;
  delete process.env.EMAIL_RELAY_URL;
  delete process.env.EMAIL_RELAY_SECRET;

  const url = new URL("../dist/server/index.js", import.meta.url);
  worker = await import(url.href).then((module) => module.default);

  // One warm-up request outside any interception, so the worker's first-use
  // module resolution does not escape the intercepted window.
  await request("/health");
});

after(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.reset();
  backgroundTasks = [];
});

// Every task the handler hands to the platform's waitUntil. server.mjs does
// the same in production: it collects them and drains them once the response
// is written, so a notification scheduled here is tracked work, not a floating
// promise nobody owns.
let backgroundTasks = [];

let clientCounter = 0;
async function request(path, init = {}) {
  clientCounter += 1;
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: {
        accept: "text/html",
        "x-forwarded-proto": "https",
        "x-forwarded-for": `198.18.2.${(clientCounter % 250) + 1}`,
      },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    {
      waitUntil(promise) {
        backgroundTasks.push(Promise.resolve(promise));
      },
      passThroughOnException() {},
    },
  );
}

/** Runs the scheduled background work, as the server does after responding. */
async function drain() {
  const pending = backgroundTasks;
  backgroundTasks = [];
  await Promise.allSettled(pending);
  return pending.length;
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const rows = async (sql) => (await testDb.db.query(sql)).rows;
const orderRows = () => rows("SELECT * FROM orders ORDER BY id");
const grantRows = () => rows("SELECT * FROM access_grants ORDER BY id");

function readFormFields(html) {
  const fields = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[match[1]] = match[2].replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  }
  return fields;
}

/** Records every message the owner would receive. */
function interceptTelegram(mode) {
  const original = globalThis.fetch;
  const messages = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.includes("api.telegram.org")) return original(input, init);
    if (url.includes("/sendMessage")) messages.push(JSON.parse(init.body).text);
    if (mode === "throws") throw new Error("network is down");
    const ok = mode !== "rejects";
    return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 500 });
  };
  return {
    messages,
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

async function startCheckout(query = "email=buyer%40example.ru") {
  const response = await request(`/api/payment/start?${query}`);
  return readFormFields(await response.text());
}

function callback(invoiceId, outSum = PILOT_AMOUNT, password = PASSWORD_2) {
  return request(
    `/api/payment/result?OutSum=${outSum}&InvId=${invoiceId}` +
      `&SignatureValue=${sha256(`${outSum}:${invoiceId}:${password}`)}`,
  );
}

/** The payment notification among everything the owner was sent. */
const paymentMessages = (telegram) =>
  telegram.messages.filter((text) => text.includes("Оплата получена"));

// --- the happy path -------------------------------------------------------

test("a first confirmed payment sends exactly one owner notification", async () => {
  await withTelegram("delivers", async (telegram) => {
    const { InvId } = await startCheckout();
    const response = await callback(InvId);

    assert.equal(await response.text(), `OK${InvId}`);

    assert.equal(await drain(), 1, "the notification was scheduled as background work");
    const sent = paymentMessages(telegram);
    assert.equal(sent.length, 1, "exactly one notification");
    assert.match(sent[0], /Оплата получена/);
    assert.match(sent[0], new RegExp(`№${InvId}`));
    assert.match(sent[0], /4\s900 ₽/u);
    assert.match(sent[0], /Пилот 7 дней/);
    assert.match(sent[0], /buyer@example\.ru/);
    assert.match(sent[0], /paid/);
  });
});

test("a subscription payment names its own tariff and amount", async () => {
  await withTelegram("delivers", async (telegram) => {
    const { InvId } = await startCheckout("plan=subscription&email=buyer%40example.ru");
    await callback(InvId, SUBSCRIPTION_AMOUNT);
    await drain();

    const [sent] = paymentMessages(telegram);
    assert.match(sent, /7\s900 ₽/u);
    assert.match(sent, /Подписка 30 дней/);
  });
});

// --- no duplicates --------------------------------------------------------

test("a duplicate callback does not notify a second time", async () => {
  await withTelegram("delivers", async (telegram) => {
    const { InvId } = await startCheckout();

    assert.equal(await (await callback(InvId)).text(), `OK${InvId}`);
    assert.equal(await (await callback(InvId)).text(), `OK${InvId}`, "a retry still gets OK");
    assert.equal(await (await callback(InvId)).text(), `OK${InvId}`);

    assert.equal(await drain(), 1, "two retries scheduled no extra background task");
    assert.equal(paymentMessages(telegram).length, 1, "only the first caller notifies");
    assert.equal((await grantRows()).length, 1, "and still exactly one grant");
  });
});

test("concurrent callbacks notify once between them", async () => {
  await withTelegram("delivers", async (telegram) => {
    const { InvId } = await startCheckout();
    await Promise.all([callback(InvId), callback(InvId), callback(InvId)]);
    assert.equal(await drain(), 1, "exactly one background task between them");

    assert.equal(paymentMessages(telegram).length, 1);
    assert.equal((await grantRows()).length, 1);
  });
});

// --- delivery failures change nothing -------------------------------------

for (const [label, mode] of [
  ["Telegram is unreachable", "throws"],
  ["Telegram rejects the message", "rejects"],
]) {
  test(`${label}: the payment still settles`, async () => {
    await withTelegram(mode, async (telegram) => {
      const { InvId } = await startCheckout();
      const response = await callback(InvId);

      assert.equal(await response.text(), `OK${InvId}`, "Robokassa still gets OK");
      assert.equal(response.status, 200);
      // The callback had already succeeded before the notification was tried.
      await drain();

      const [order] = await orderRows();
      assert.equal(order.status, "paid");
      assert.ok(order.paid_at);

      const grants = await grantRows();
      assert.equal(grants.length, 1, "exactly one grant, unaffected");
      assert.ok(telegram.messages.length >= 1, "delivery was attempted");
    });
  });
}

test("a missing bot token does not fail the callback", async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    await withTelegram("delivers", async (telegram) => {
      const { InvId } = await startCheckout();
      const response = await callback(InvId);

      assert.equal(await response.text(), `OK${InvId}`);
      await drain();
      assert.equal((await orderRows())[0].status, "paid");
      assert.equal((await grantRows()).length, 1);
      assert.equal(telegram.messages.length, 0, "nothing is sent without a token");
    });
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

// --- nothing else notifies ------------------------------------------------

test("an invalid signature notifies nobody", async () => {
  await withTelegram("delivers", async (telegram) => {
    const { InvId } = await startCheckout();

    const forged = await callback(InvId, PILOT_AMOUNT, PASSWORD_1);
    assert.equal(forged.status, 403);
    assert.equal(await drain(), 0, "a rejected callback schedules no background work");
    assert.equal(paymentMessages(telegram).length, 0);
    assert.equal((await orderRows())[0].status, "pending");
  });
});

test("an amount mismatch notifies nobody", async () => {
  await withTelegram("delivers", async (telegram) => {
    const { InvId } = await startCheckout();

    const wrong = await callback(InvId, SUBSCRIPTION_AMOUNT);
    assert.equal(wrong.status, 400);
    assert.equal(await drain(), 0, "a rejected callback schedules no background work");
    assert.equal(paymentMessages(telegram).length, 0);
    assert.equal((await orderRows())[0].status, "pending");
    assert.equal((await grantRows()).length, 0);
  });
});

test("an unknown invoice notifies nobody", async () => {
  await withTelegram("delivers", async (telegram) => {
    const response = await callback("999999999999");
    assert.equal(response.status, 404);
    assert.equal(await drain(), 0);
    assert.equal(paymentMessages(telegram).length, 0);
  });
});

test("a business order gets no payment notification from ResultURL", async () => {
  await withTelegram("delivers", async (telegram) => {
    // The business checkout announces itself to the owner — that message is a
    // different one and must not be mistaken for a payment confirmation.
    const businessQuery =
      `email=buyer%40company.ru&buyerType=business&buyerInn=${ORG_INN}` +
      "&buyerName=%D0%9E%D0%9E%D0%9E%20%C2%AB%D0%A0%D0%BE%D0%BC%D0%B0%D1%88%D0%BA%D0%B0%C2%BB";
    await request(`/api/payment/start?${businessQuery}`);
    const [order] = await orderRows();
    assert.equal(order.status, "awaiting_bank_payment");

    const response = await callback(String(order.invoice_id));
    assert.equal(response.status, 409, "a business order is not payable through Robokassa");
    assert.equal(await drain(), 0, "no background task for a business callback");

    assert.equal(paymentMessages(telegram).length, 0, "no payment confirmation");
    assert.equal((await orderRows())[0].status, "awaiting_bank_payment");
    assert.equal((await grantRows()).length, 0);
  });
});

// --- the message itself ---------------------------------------------------

test("the notification carries no secret", async () => {
  await withTelegram("delivers", async (telegram) => {
    const { InvId } = await startCheckout();
    await callback(InvId);
    await drain();
    const [sent] = paymentMessages(telegram);

    const [order] = await orderRows();
    for (const secret of [
      order.session_hash,
      PASSWORD_1,
      PASSWORD_2,
      BOT_TOKEN,
      testDb.url,
      "postgresql://",
      "token=",
      "SignatureValue",
    ]) {
      assert.ok(!sent.includes(secret), `the notification leaked ${String(secret).slice(0, 14)}…`);
    }
    // No recovery link either: the access token exists only in the customer's
    // email, and a link in Telegram would be a second way to spend it.
    assert.doesNotMatch(sent, /\/api\/access/);
    assert.doesNotMatch(sent, /https?:\/\//);
  });
});

test("a customer-supplied email cannot inject markup", () => {
  // parse_mode is HTML, so every value in the message is escaped.
  const message = createPaymentNotification({
    invoiceId: "412040522831714",
    amount: PILOT_AMOUNT,
    plan: "pilot",
    email: "<b>spoof</b>@example.ru",
    status: "paid",
  });

  assert.doesNotMatch(message.replace(/<\/?b>/g, ""), /<[a-z]/i, "no unescaped tag survives");
  assert.match(message, /&lt;b&gt;spoof&lt;\/b&gt;@example\.ru/);
});

test("the message is built only from what identifies the sale", () => {
  const message = createPaymentNotification({
    invoiceId: "412040522831714",
    amount: PILOT_AMOUNT,
    plan: "pilot",
    email: "buyer@example.ru",
    status: "paid",
  });

  assert.equal(message.split("\n").length, 6, "header plus five lines");
  assert.match(message, /^<b>✅ Оплата получена<\/b>$/m);
  assert.match(message, /№412040522831714/);
  assert.match(message, /4\s900 ₽/u);
  assert.ok(message.length <= 4_000, "and it fits in one Telegram message");
});

// --- the notification is off the critical path ----------------------------

test("OK is answered without waiting for Telegram", async () => {
  // Telegram hangs until the test releases it. If the handler awaited the
  // notification, this callback could never return.
  const original = globalThis.fetch;
  let release;
  const hung = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.includes("api.telegram.org")) return original(input, init);
    await hung;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const { InvId } = await startCheckout();
    const started = Date.now();
    const response = await callback(InvId);
    const elapsed = Date.now() - started;

    assert.equal(await response.text(), `OK${InvId}`);
    assert.ok(elapsed < 2_000, `the callback waited ${elapsed}ms for Telegram`);

    // The money is recorded and the entitlement exists before the owner has
    // been told anything at all.
    assert.equal((await orderRows())[0].status, "paid");
    assert.equal((await grantRows()).length, 1);
    assert.equal(backgroundTasks.length, 1, "the notification is pending as background work");

    release();
    await drain();
  } finally {
    globalThis.fetch = original;
  }
});

test("the background task is handed to the platform, not left floating", async () => {
  // waitUntil is what server.mjs implements: it collects the promise and
  // drains it after the response is written. Scheduling through it is the
  // difference between tracked work and a promise nobody owns.
  await withTelegram("delivers", async () => {
    const { InvId } = await startCheckout();
    await callback(InvId);

    assert.equal(backgroundTasks.length, 1);
    assert.ok(typeof backgroundTasks[0].then === "function", "a real promise was handed over");
    await drain();
  });
});

test("a failing notification settles quietly and never rejects the task", async () => {
  await withTelegram("throws", async (telegram) => {
    const { InvId } = await startCheckout();
    assert.equal(await (await callback(InvId)).text(), `OK${InvId}`);

    // An unhandled rejection here would take the process down in production,
    // so the scheduled task must resolve even when delivery fails.
    const [settled] = await Promise.allSettled([...backgroundTasks]);
    assert.equal(settled.status, "fulfilled", "the background task must not reject");
    await drain();

    assert.ok(telegram.messages.length >= 1, "delivery was attempted in the background");
    assert.equal((await orderRows())[0].status, "paid");
    assert.equal((await grantRows()).length, 1);
  });
});

test("only the confirmed branch schedules background work", async () => {
  await withTelegram("delivers", async () => {
    // Rejected outcomes: nothing scheduled.
    await callback("999999999999");
    assert.equal(await drain(), 0, "unknown order");

    const { InvId } = await startCheckout();
    await callback(InvId, SUBSCRIPTION_AMOUNT);
    assert.equal(await drain(), 0, "amount mismatch");

    await callback(InvId, PILOT_AMOUNT, PASSWORD_1);
    assert.equal(await drain(), 0, "bad signature");

    // Confirmed: exactly one. Duplicate: none.
    await callback(InvId);
    assert.equal(await drain(), 1, "confirmed");

    await callback(InvId);
    assert.equal(await drain(), 0, "duplicate");
  });
});

test("the access email is still delivered on the critical path", async () => {
  // Deliberately not moved to the background: it is the customer's only way
  // back in, and nothing retries it automatically. This pins that decision so
  // it cannot drift without someone noticing.
  const source = await readFile(new URL("../app/api/payment/result/route.ts", import.meta.url), "utf-8");
  const confirmed = source.slice(source.indexOf('case "confirmed"'));

  assert.match(confirmed, /await deliverAccessEmail\(/, "the email is awaited");
  // Whatever after() wraps, it must not be the email: strip the scheduled
  // block and the awaited call has to still be there.
  const withoutScheduled = confirmed.replace(/after\([\s\S]*?\n {6}\);/, "");
  assert.match(withoutScheduled, /await deliverAccessEmail\(/, "the email stays awaited");
  assert.doesNotMatch(
    confirmed,
    /after\(\s*\n?\s*deliverAccessEmail/,
    "the email must not be moved into after()",
  );
  assert.match(confirmed, /after\(\s*\n?\s*sendOwnerMessage\(/, "the notification is scheduled");
});
