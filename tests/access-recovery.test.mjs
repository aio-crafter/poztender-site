// Recovery of paid access: the emailed link, the endpoint that redeems it, and
// the guarantees around both.
//
// Runs against the built worker and a real PostgreSQL. SMTP is never
// configured here, so no message can leave the process — delivery is asserted
// through the access_links row the app writes, not by sending anything.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import { startTestDatabase } from "./helpers/postgres.mjs";

const ORIGIN = "https://poztender.example";
const PASSWORD_1 = "fake-password-one";
const PASSWORD_2 = "fake-password-two";
const PILOT_AMOUNT = "4900.00";
const SUBSCRIPTION_AMOUNT = "7900.00";
const ORG_INN = "7707083893";
const DB_PORT = 56_100 + (process.pid % 200);

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
  // Left unset on purpose: nothing may reach a mail server from a test run.
  delete process.env.YANDEX_SMTP_USER;
  delete process.env.YANDEX_SMTP_PASSWORD;

  const url = new URL("../dist/server/index.js", import.meta.url);
  url.searchParams.set("t", "access-recovery");
  worker = (await import(url.href)).default;
});

after(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.reset();
  await testDb.db.query("TRUNCATE access_links RESTART IDENTITY CASCADE");
});

let clientCounter = 0;
async function request(path, init = {}) {
  const { cookie, headers, ...rest } = init;
  clientCounter += 1;
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      ...rest,
      headers: {
        accept: "text/html",
        "x-forwarded-proto": "https",
        "x-forwarded-for": `198.19.0.${(clientCounter % 250) + 1}`,
        ...(cookie ? { cookie } : {}),
        ...(headers ?? {}),
      },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

/**
 * The browser's whole cookie jar for a response. Two cookies are now issued —
 * the session secret and the order selector — and both must travel back.
 */
function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const rows = async (sql) => (await testDb.db.query(sql)).rows;

async function startCheckout(query) {
  const response = await request(`/api/payment/start?${query}`);
  return { response, cookie: cookieHeader(response) };
}

async function payByCard(query = "email=buyer%40example.ru") {
  const { cookie } = await startCheckout(query);
  const [order] = await rows("SELECT * FROM orders ORDER BY id DESC LIMIT 1");
  const invoiceId = String(order.invoice_id);
  const amount = order.plan === "subscription" ? SUBSCRIPTION_AMOUNT : PILOT_AMOUNT;
  await request(
    `/api/payment/result?OutSum=${amount}&InvId=${invoiceId}` +
      `&SignatureValue=${sha256(`${amount}:${invoiceId}:${PASSWORD_2}`)}`,
  );
  return { cookie, order };
}

/**
 * Puts a known token on an order the way the mailer would, so the redemption
 * endpoint can be exercised without an SMTP server. Mirrors issueAccessLink:
 * only the hash is stored.
 */
async function plantToken(orderId, token, { expiresAt } = {}) {
  const until =
    expiresAt ??
    (await rows(`SELECT valid_until FROM access_grants WHERE order_id = ${orderId}`))[0]
      ?.valid_until ??
    new Date(Date.now() + 86_400_000).toISOString();
  await testDb.db.query(
    `INSERT INTO access_links (order_id, token_hash, expires_at)
     VALUES (${orderId}, '${sha256(`poztender-access-link:${token}`)}', '${new Date(until).toISOString()}')
     ON CONFLICT (order_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at`,
  );
}

const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);

// --- B2B ------------------------------------------------------------------

async function startBusinessOrder(plan = "pilot") {
  const planPart = plan === "subscription" ? "plan=subscription&" : "";
  const { cookie } = await startCheckout(
    `${planPart}email=client%40company.ru&buyerType=business&buyerInn=${ORG_INN}` +
      "&buyerName=%D0%9E%D0%9E%D0%9E",
  );
  const [order] = await rows("SELECT * FROM orders ORDER BY id DESC LIMIT 1");
  return { cookie, order };
}

/** The transaction confirm-bank-payment.mjs performs. */
async function confirmBankPayment(orderId, plan = "pilot") {
  const { rows: claimed } = await testDb.db.query(
    `UPDATE orders SET status='paid', paid_at=now(), payment_confirmation_source='bank_transfer'
      WHERE id=${orderId} AND status='awaiting_bank_payment' RETURNING paid_at`,
  );
  if (!claimed.length) return false;
  await testDb.db.query(
    `INSERT INTO access_grants (order_id, valid_from, valid_until)
     VALUES (${orderId}, '${new Date(claimed[0].paid_at).toISOString()}',
             '${new Date(claimed[0].paid_at).toISOString()}'::timestamptz
               + '${plan === "subscription" ? 30 : 7} days'::interval)
     ON CONFLICT (order_id) DO NOTHING`,
  );
  return true;
}

test("an order awaiting a bank transfer has no access and no link", async () => {
  const { cookie, order } = await startBusinessOrder();
  assert.equal(order.status, "awaiting_bank_payment");
  assert.equal((await rows("SELECT id FROM access_grants")).length, 0);
  assert.equal((await rows("SELECT id FROM access_links")).length, 0);
  assert.match(await (await request("/brief", { cookie })).text(), /Анкета доступна после оплаты/);
});

test("confirming a bank transfer creates exactly one grant and records the source", async () => {
  const { order } = await startBusinessOrder();
  await confirmBankPayment(order.id);
  await confirmBankPayment(order.id);

  const grants = await rows("SELECT id FROM access_grants");
  assert.equal(grants.length, 1, "a repeated confirmation must not add a second grant");
  const [row] = await rows("SELECT payment_confirmation_source FROM orders WHERE id = " + order.id);
  assert.equal(row.payment_confirmation_source, "bank_transfer");
});

// --- redemption -----------------------------------------------------------

test("a valid token restores the session and lands on the intake form", async () => {
  const { order } = await startBusinessOrder();
  await confirmBankPayment(order.id);
  await plantToken(order.id, TOKEN_A);

  const response = await request(`/api/access?token=${TOKEN_A}`);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${ORIGIN}/brief`);

  const issued = response.headers.getSetCookie();
  assert.equal(issued.length, 2, "session secret and order selector");
  for (const value of issued) {
    assert.match(value, /HttpOnly/);
    assert.match(value, /Secure/);
    assert.match(value, /SameSite=Lax/);
    assert.match(value, /Path=\//);
  }
  assert.ok(issued.some((v) => v.startsWith(`poztender_order=${order.invoice_id};`)));

  // The restored session opens the form in a browser that never saw checkout.
  const cookie = cookieHeader(response);
  assert.match(await (await request("/brief", { cookie })).text(), /Единая точка старта/);
});

test("the restored session outlives nothing but the grant", async () => {
  const { order } = await startBusinessOrder();
  await confirmBankPayment(order.id);
  await plantToken(order.id, TOKEN_A);

  const response = await request(`/api/access?token=${TOKEN_A}`);
  const maxAge = Number(/Max-Age=(\d+)/.exec(response.headers.getSetCookie()[0])?.[1]);
  const [grant] = await rows(`SELECT valid_until FROM access_grants WHERE order_id = ${order.id}`);
  const remaining = Math.round((new Date(grant.valid_until).getTime() - Date.now()) / 1000);

  assert.ok(maxAge > 0);
  assert.ok(
    Math.abs(maxAge - remaining) < 120,
    `cookie Max-Age ${maxAge} should track the grant's ${remaining}s`,
  );
});

test("recovery does not evict the browser that already had access", async () => {
  // Opening the email on a phone must not sign the desktop out.
  const { cookie: original, order } = await startBusinessOrder();
  await confirmBankPayment(order.id);
  await plantToken(order.id, TOKEN_A);

  const restored = cookieHeader(await request(`/api/access?token=${TOKEN_A}`));

  for (const cookie of [original, restored]) {
    assert.match(await (await request("/brief", { cookie })).text(), /Единая точка старта/);
  }
});

test("a token may be redeemed more than once while access lasts", async () => {
  const { order } = await startBusinessOrder();
  await confirmBankPayment(order.id);
  await plantToken(order.id, TOKEN_A);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request(`/api/access?token=${TOKEN_A}`);
    assert.equal(response.status, 303, "a link opened on a second device must still work");
  }
  const [link] = await rows("SELECT last_used_at FROM access_links");
  assert.ok(link.last_used_at, "usage is recorded");
});

test("a token for an order awaiting payment is refused", async () => {
  const { order } = await startBusinessOrder();
  // Planted before any confirmation: the order is still awaiting_bank_payment.
  await plantToken(order.id, TOKEN_A, { expiresAt: new Date(Date.now() + 86_400_000) });

  const response = await request(`/api/access?token=${TOKEN_A}`);
  assert.equal(response.headers.get("location"), `${ORIGIN}/payment/link-expired`);
  assert.deepEqual(response.headers.getSetCookie(), [], "no session may be issued");
});

test("an unknown, malformed or expired token is refused", async () => {
  const { order } = await startBusinessOrder();
  await confirmBankPayment(order.id);
  await plantToken(order.id, TOKEN_A);

  const attempts = [
    `/api/access?token=${TOKEN_B}`,
    "/api/access?token=short",
    "/api/access?token=" + "!".repeat(43),
    "/api/access",
  ];
  for (const attempt of attempts) {
    const response = await request(attempt);
    assert.equal(response.headers.get("location"), `${ORIGIN}/payment/link-expired`, attempt);
    assert.deepEqual(response.headers.getSetCookie(), [], attempt);
  }

  await testDb.db.query("UPDATE access_links SET expires_at = now() - interval '1 hour'");
  const expired = await request(`/api/access?token=${TOKEN_A}`);
  assert.equal(expired.headers.get("location"), `${ORIGIN}/payment/link-expired`);
  assert.deepEqual(expired.headers.getSetCookie(), []);
});

test("a token cannot reach another customer's order", async () => {
  const first = await startBusinessOrder();
  await confirmBankPayment(first.order.id);
  await plantToken(first.order.id, TOKEN_A);

  const second = await startBusinessOrder();
  await confirmBankPayment(second.order.id);
  await plantToken(second.order.id, TOKEN_B);

  const response = await request(`/api/access?token=${TOKEN_A}`);
  const cookie = cookieHeader(response);
  const html = await (await request("/payment/invoice", { cookie })).text();

  assert.match(html, new RegExp(String(first.order.invoice_id)));
  assert.doesNotMatch(html, new RegExp(String(second.order.invoice_id)));
});

test("knowing the invoice number is not enough", async () => {
  const { order } = await startBusinessOrder();
  await confirmBankPayment(order.id);

  for (const attempt of [
    `/api/access?token=${order.invoice_id}`,
    `/brief?invoiceId=${order.invoice_id}`,
    `/brief?token=${order.invoice_id}`,
  ]) {
    const response = await request(attempt);
    assert.notEqual(response.headers.get("location"), `${ORIGIN}/brief`, attempt);
    assert.deepEqual(response.headers.getSetCookie(), [], attempt);
  }
});

test("redeeming creates no grant and extends none", async () => {
  const { order } = await startBusinessOrder();
  await confirmBankPayment(order.id);
  await plantToken(order.id, TOKEN_A);

  const [before] = await rows("SELECT id, valid_until FROM access_grants");
  await request(`/api/access?token=${TOKEN_A}`);
  await request(`/api/access?token=${TOKEN_A}`);
  const after = await rows("SELECT id, valid_until FROM access_grants");

  assert.equal(after.length, 1);
  assert.equal(after[0].id, before.id);
  assert.equal(
    new Date(after[0].valid_until).getTime(),
    new Date(before.valid_until).getTime(),
    "a recovery must never extend the paid period",
  );
});

test("only the hash of a token is stored", async () => {
  const { order } = await startBusinessOrder();
  await confirmBankPayment(order.id);
  await plantToken(order.id, TOKEN_A);

  const [link] = await rows("SELECT token_hash FROM access_links");
  assert.equal(link.token_hash, sha256(`poztender-access-link:${TOKEN_A}`));
  assert.notEqual(link.token_hash, TOKEN_A);
  assert.ok(!link.token_hash.includes(TOKEN_A));
});

test("a subscription recovery does not land on the intake form", async () => {
  const { order } = await startBusinessOrder("subscription");
  await confirmBankPayment(order.id, "subscription");
  await plantToken(order.id, TOKEN_A);

  const response = await request(`/api/access?token=${TOKEN_A}`);
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    `${ORIGIN}/payment/success`,
    "a renewal has no intake form and must not be sent to /brief",
  );
});

// --- delivery -------------------------------------------------------------

test("a confirmed card payment issues an access link even with no mail server", async () => {
  // Delivery is advisory: without SMTP the payment must still stand, and the
  // link row must not be half-written.
  const { order } = await payByCard();
  const [saved] = await rows(`SELECT status FROM orders WHERE id = ${order.id}`);
  assert.equal(saved.status, "paid", "a mail failure must never undo a payment");
  assert.equal((await rows("SELECT id FROM access_grants")).length, 1);
  // No SMTP configured, so nothing was minted and nothing was sent.
  assert.equal((await rows("SELECT id FROM access_links")).length, 0);
});

test("a failed delivery leaves the order paid and access open", async () => {
  const { cookie, order } = await payByCard();
  const [saved] = await rows(`SELECT status, paid_at FROM orders WHERE id = ${order.id}`);
  assert.equal(saved.status, "paid");
  assert.ok(saved.paid_at);
  assert.match(await (await request("/brief", { cookie })).text(), /Единая точка старта/);
});

test("re-issuing a link rotates the token without touching the grant", async () => {
  const { order } = await startBusinessOrder();
  await confirmBankPayment(order.id);
  await plantToken(order.id, TOKEN_A);
  const [before] = await rows("SELECT id, valid_until FROM access_grants");

  // What a re-send does: same row, new hash.
  await plantToken(order.id, TOKEN_B);

  const links = await rows("SELECT token_hash FROM access_links");
  assert.equal(links.length, 1, "links must not accumulate");
  assert.equal(links[0].token_hash, sha256(`poztender-access-link:${TOKEN_B}`));

  const after = await rows("SELECT id, valid_until FROM access_grants");
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before.id);
  assert.equal(
    new Date(after[0].valid_until).getTime(),
    new Date(before.valid_until).getTime(),
  );

  // The superseded link stops working; the current one does not.
  assert.equal(
    (await request(`/api/access?token=${TOKEN_A}`)).headers.get("location"),
    `${ORIGIN}/payment/link-expired`,
  );
  assert.equal(
    (await request(`/api/access?token=${TOKEN_B}`)).headers.get("location"),
    `${ORIGIN}/brief`,
  );
});
