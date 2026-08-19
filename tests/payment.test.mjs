// Payment-flow tests against the built worker and a real PostgreSQL (PGlite
// over a TCP socket). No request leaves the machine and no payment is made.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import { startTestDatabase } from "./helpers/postgres.mjs";

const ORIGIN = "https://poztender.example";
const MERCHANT_LOGIN = "poztender-test";
const PASSWORD_1 = "fake-password-one";
const PASSWORD_2 = "fake-password-two";
const PILOT_AMOUNT = "4900.00";
const SUBSCRIPTION_AMOUNT = "7900.00";
const DB_PORT = 55_432 + (process.pid % 200);

let testDb;
let worker;

before(async () => {
  testDb = await startTestDatabase(DB_PORT);
  process.env.DATABASE_URL = testDb.url;
  // PGlite serves one backend, so the pool must not try to open several.
  process.env.DATABASE_POOL_MAX = "1";
  process.env.ROBOKASSA_MERCHANT_LOGIN = MERCHANT_LOGIN;
  process.env.ROBOKASSA_PASSWORD_1 = PASSWORD_1;
  process.env.ROBOKASSA_PASSWORD_2 = PASSWORD_2;
  process.env.ROBOKASSA_TEST_MODE = "true";
  process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "false";

  worker = await loadWorker();
});

after(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.reset();
});

function loadWorker(cacheKey = "shared") {
  const url = new URL("../dist/server/index.js", import.meta.url);
  url.searchParams.set("t", cacheKey);
  return import(url.href).then((module) => module.default);
}

// Each request comes from its own address unless a test pins one, so that the
// rate limiters see distinct clients instead of treating the whole suite as a
// single flooding caller.
let clientCounter = 0;
function nextClientAddress() {
  clientCounter += 1;
  return `198.18.${Math.floor(clientCounter / 254) % 254}.${(clientCounter % 254) + 1}`;
}

async function request(path, init = {}, instance = worker) {
  const { cookie, ...rest } = init;
  return instance.fetch(
    new Request(`${ORIGIN}${path}`, {
      headers: {
        accept: "text/html",
        "x-forwarded-proto": "https",
        "x-forwarded-for": nextClientAddress(),
        ...(cookie ? { cookie } : {}),
        ...(rest.headers ?? {}),
      },
      ...rest,
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const resultSignature = (outSum, invId, password = PASSWORD_2) =>
  sha256(`${outSum}:${invId}:${password}`);
const successSignature = (outSum, invId, password = PASSWORD_1) =>
  sha256(`${outSum}:${invId}:${password}`);

function readFormFields(html) {
  const fields = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[match[1]] = match[2].replaceAll("&amp;", "&").replaceAll("&quot;", '"');
  }
  return fields;
}

/** Runs a checkout and returns the Robokassa fields plus the browser's cookie. */
async function startCheckout(query = "email=buyer%40example.ru") {
  const response = await request(`/api/payment/start?${query}`);
  assert.equal(response.status, 200, "checkout should render the Robokassa form");
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  return { fields: readFormFields(await response.text()), cookie, setCookie };
}

const rows = async (sql) => (await testDb.db.query(sql)).rows;
const orderRows = () => rows("SELECT * FROM orders ORDER BY id");
const grantRows = () => rows("SELECT * FROM access_grants ORDER BY id");

async function payCallback(invoiceId, outSum = PILOT_AMOUNT, signature) {
  return request(
    `/api/payment/result?OutSum=${outSum}&InvId=${invoiceId}` +
      `&SignatureValue=${signature ?? resultSignature(outSum, invoiceId)}`,
  );
}

// --- checkout -------------------------------------------------------------

test("checkout creates exactly one pending order and issues a session cookie", async () => {
  const { fields, setCookie } = await startCheckout();

  const orders = await orderRows();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, "pending");
  assert.equal(orders[0].plan, "pilot");
  assert.equal(orders[0].expected_amount, PILOT_AMOUNT);
  assert.equal(orders[0].email, "buyer@example.ru");
  assert.equal(orders[0].paid_at, null);
  assert.equal(String(orders[0].invoice_id), fields.InvId);

  assert.match(setCookie, /^poztender_checkout=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);

  // Only the hash is stored; the cookie value itself must not be in the row.
  const secret = setCookie.split("=")[1].split(";")[0];
  assert.equal(orders[0].session_hash, sha256(`poztender-checkout:${secret}`));
  assert.notEqual(orders[0].session_hash, secret);

  // No entitlement exists before payment is confirmed.
  assert.equal((await grantRows()).length, 0);
});

test("checkout accepts a POST form submission", async () => {
  const response = await request("/api/payment/start", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "plan=subscription&email=buyer%40example.ru",
  });
  assert.equal(response.status, 200);
  const orders = await orderRows();
  assert.equal(orders[0].plan, "subscription");
  assert.equal(orders[0].expected_amount, SUBSCRIPTION_AMOUNT);
});

test("invoice ids are unique and unpredictable", async () => {
  const seen = new Set();
  for (let index = 0; index < 8; index += 1) {
    const { fields } = await startCheckout();
    assert.ok(!seen.has(fields.InvId), "invoice id repeated");
    seen.add(fields.InvId);
    assert.ok(Number.isSafeInteger(Number(fields.InvId)));
  }
  // Sequential ids would make orders enumerable; these must not be adjacent.
  const sorted = [...seen].map(Number).sort((a, b) => a - b);
  assert.ok(sorted[sorted.length - 1] - sorted[0] > 1000);

  const uniqueInDb = await rows("SELECT COUNT(DISTINCT invoice_id)::int AS c FROM orders");
  assert.equal(uniqueInDb[0].c, 8);
});

test("the database rejects a duplicate invoice id", async () => {
  await startCheckout();
  const [order] = await orderRows();
  await assert.rejects(
    () =>
      testDb.db.query(
        `INSERT INTO orders (invoice_id, plan, expected_amount, email, session_hash)
         VALUES (${order.invoice_id}, 'pilot', 4900.00, 'x@example.ru', 'hash')`,
      ),
    /duplicate key|unique/i,
  );
});

test("the server sets the price and ignores anything the client sends", async () => {
  for (const attack of [
    "OutSum=1",
    "OutSum=0",
    "OutSum=-4900.00",
    "amount=1",
    "price=1",
    "expectedAmount=1",
    "plan=free",
    "tariff=free",
  ]) {
    await testDb.reset();
    const { fields } = await startCheckout(`email=buyer%40example.ru&${attack}`);
    assert.equal(fields.OutSum, PILOT_AMOUNT, attack);
    const orders = await orderRows();
    assert.equal(orders[0].expected_amount, PILOT_AMOUNT, attack);
  }
});

test("only the exact subscription identifier selects the higher price", async () => {
  const { fields: exact } = await startCheckout("plan=subscription&email=b%40example.ru");
  assert.equal(exact.OutSum, SUBSCRIPTION_AMOUNT);
  await testDb.reset();
  const { fields: nearMiss } = await startCheckout("plan=Subscription&email=b%40example.ru");
  assert.equal(nearMiss.OutSum, PILOT_AMOUNT);
});

// --- ResultURL ------------------------------------------------------------

test("a valid callback marks the order paid and creates exactly one entitlement", async () => {
  const { fields } = await startCheckout();
  const response = await payCallback(fields.InvId);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), `OK${fields.InvId}`);

  const [order] = await orderRows();
  assert.equal(order.status, "paid");
  assert.ok(order.paid_at);

  const grants = await grantRows();
  assert.equal(grants.length, 1);
  assert.equal(grants[0].order_id, order.id);
  assert.equal(grants[0].used_at, null);
  assert.equal(grants[0].revoked_at, null);
  // The window runs from the confirmed payment, not from any page visit.
  assert.equal(new Date(grants[0].valid_from).getTime(), new Date(order.paid_at).getTime());
  const days = (new Date(grants[0].valid_until) - new Date(grants[0].valid_from)) / 86_400_000;
  assert.equal(Math.round(days), 7);
});

test("an invalid signature leaves the order untouched", async () => {
  const { fields } = await startCheckout();

  const forged = await payCallback(fields.InvId, PILOT_AMOUNT, "0".repeat(64));
  assert.equal(forged.status, 403);

  // Signed with Password#1, the SuccessURL password, instead of Password#2.
  const wrongPassword = await payCallback(
    fields.InvId,
    PILOT_AMOUNT,
    resultSignature(PILOT_AMOUNT, fields.InvId, PASSWORD_1),
  );
  assert.equal(wrongPassword.status, 403);

  const [order] = await orderRows();
  assert.equal(order.status, "pending");
  assert.equal(order.paid_at, null);
  assert.equal((await grantRows()).length, 0);
});

test("a mismatched amount leaves the order untouched", async () => {
  // A subscription-priced callback, correctly signed, against a pilot order.
  const { fields } = await startCheckout();
  const response = await payCallback(fields.InvId, SUBSCRIPTION_AMOUNT);

  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /^OK/);

  const [order] = await orderRows();
  assert.equal(order.status, "pending");
  assert.equal((await grantRows()).length, 0);
});

test("a callback for an invoice this shop never issued is refused", async () => {
  const unknown = "4503599627370496";
  const response = await payCallback(unknown);
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /^OK/);
  assert.equal((await orderRows()).length, 0);
});

test("a repeated callback changes nothing but still answers OK", async () => {
  const { fields } = await startCheckout();
  const first = await payCallback(fields.InvId);
  assert.equal(first.status, 200);

  const [afterFirst] = await orderRows();
  const originalPaidAt = new Date(afterFirst.paid_at).getTime();

  for (let repeat = 0; repeat < 3; repeat += 1) {
    const again = await payCallback(fields.InvId);
    assert.equal(again.status, 200);
    assert.equal(await again.text(), `OK${fields.InvId}`);
  }

  const [order] = await orderRows();
  assert.equal(new Date(order.paid_at).getTime(), originalPaidAt, "paidAt must not move");
  assert.equal((await grantRows()).length, 1, "no second entitlement");
});

test("two simultaneous callbacks produce one payment and one entitlement", async () => {
  const { fields } = await startCheckout();

  const responses = await Promise.all([
    payCallback(fields.InvId),
    payCallback(fields.InvId),
    payCallback(fields.InvId),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `OK${fields.InvId}`);
  }

  assert.equal((await grantRows()).length, 1);
  const paid = await rows("SELECT COUNT(*)::int AS c FROM orders WHERE status = 'paid'");
  assert.equal(paid[0].c, 1);
});

// A database outage cannot be simulated in this file: the bundled `pg` driver
// and its pool live in a shared chunk, so re-importing the worker under a
// different URL still reuses the pool that is already connected here. That
// scenario runs in its own process — see tests/payment-db-down.test.mjs.

// --- SuccessURL -----------------------------------------------------------

test("SuccessURL creates nothing and grants nothing before the callback", async () => {
  const { cookie } = await startCheckout();

  const response = await request("/payment/success", { cookie });
  const html = await response.text();
  assert.match(html, /Платёж обрабатывается/);
  assert.doesNotMatch(html, /Заполнить профиль радара/);

  const [order] = await orderRows();
  assert.equal(order.status, "pending", "SuccessURL must not change order status");
  assert.equal((await grantRows()).length, 0, "SuccessURL must not create an entitlement");
});

test("SuccessURL shows access once the callback has confirmed the payment", async () => {
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);

  const html = await (await request("/payment/success", { cookie })).text();
  assert.match(html, /Платёж подтверждён/);
  assert.match(html, /href="\/brief"/);
  assert.equal((await grantRows()).length, 1);
});

test("reloading SuccessURL never mints a second entitlement", async () => {
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);

  const [before] = await grantRows();
  for (let visit = 0; visit < 5; visit += 1) {
    await request("/payment/success", { cookie });
  }
  const grants = await grantRows();

  assert.equal(grants.length, 1);
  assert.equal(grants[0].id, before.id);
  assert.equal(
    new Date(grants[0].valid_until).getTime(),
    new Date(before.valid_until).getTime(),
    "the access window must not be extended by revisiting the page",
  );
});

test("SuccessURL without a cookie gives nothing away", async () => {
  const { fields } = await startCheckout();
  await payCallback(fields.InvId);

  const html = await (await request("/payment/success")).text();
  assert.match(html, /Подтверждение не получено/);
  assert.doesNotMatch(html, /href="\/brief"/);
});

test("a forged or foreign cookie gives no access", async () => {
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);
  const secret = cookie.split("=")[1];

  const forged = [
    "poztender_checkout=" + "A".repeat(43),
    "poztender_checkout=" + secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A"),
    "poztender_checkout=short",
    "poztender_checkout=" + secret + "extra",
  ];
  for (const attempt of forged) {
    const html = await (await request("/payment/success", { cookie: attempt })).text();
    assert.match(html, /Подтверждение не получено/, attempt);
    const briefHtml = await (await request("/brief", { cookie: attempt })).text();
    assert.match(briefHtml, /Анкета доступна после оплаты/, attempt);
  }
});

test("the query parameters Robokassa appends to SuccessURL carry no authority", async () => {
  const { fields } = await startCheckout();
  // Correctly signed with Password#1, exactly as Robokassa would send it, but
  // with no session cookie and no confirmed callback.
  const html = await (
    await request(
      `/payment/success?InvId=${fields.InvId}&OutSum=${PILOT_AMOUNT}` +
        `&SignatureValue=${successSignature(PILOT_AMOUNT, fields.InvId)}`,
    )
  ).text();

  assert.match(html, /Подтверждение не получено/);
  const [order] = await orderRows();
  assert.equal(order.status, "pending");
  assert.equal((await grantRows()).length, 0);
});

// --- brief and intake -----------------------------------------------------

test("/brief opens only for a paid order in the same browser", async () => {
  const { fields, cookie } = await startCheckout();

  const beforePayment = await (await request("/brief", { cookie })).text();
  assert.match(beforePayment, /Анкета доступна после оплаты/);

  await payCallback(fields.InvId);

  const afterPayment = await (await request("/brief", { cookie })).text();
  assert.match(afterPayment, /Единая точка старта/);
  // The old URL-borne access parameters are gone from the form entirely.
  assert.doesNotMatch(afterPayment, /name="accessToken"|name="accessExpires"|name="outSum"/);
});

test("an expired entitlement closes the brief", async () => {
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);
  await testDb.db.query("UPDATE access_grants SET valid_until = now() - interval '1 hour'");

  const html = await (await request("/brief", { cookie })).text();
  assert.match(html, /Анкета доступна после оплаты/);
});

test("a revoked entitlement closes the brief", async () => {
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);
  await testDb.db.query("UPDATE access_grants SET revoked_at = now()");

  const html = await (await request("/brief", { cookie })).text();
  assert.match(html, /Анкета доступна после оплаты/);
});

test("a spent entitlement closes the brief", async () => {
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);
  await testDb.db.query("UPDATE access_grants SET used_at = now()");

  const html = await (await request("/brief", { cookie })).text();
  assert.match(html, /Анкета доступна после оплаты/);
});

test("the retired URL-token scheme no longer opens anything", async () => {
  // These are the shapes the previous stateless scheme accepted. They must now
  // be inert even when the numbers correspond to a genuinely paid order.
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);

  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const legacyToken = sha256(
    `poztender-intake:${fields.InvId}:${PILOT_AMOUNT}:${expires}:${PASSWORD_2}`,
  );
  const legacyUrl =
    `/brief?InvId=${fields.InvId}&OutSum=${PILOT_AMOUNT}` +
    `&expires=${expires}&access=${legacyToken}`;

  assert.match(await (await request(legacyUrl)).text(), /Анкета доступна после оплаты/);

  // And the same link in a browser that did pay still ignores the parameters:
  // access comes from the cookie, so tampering with them changes nothing.
  assert.match(await (await request(legacyUrl, { cookie })).text(), /Единая точка старта/);
});

test("intake refuses a submission without the checkout cookie", async () => {
  const { fields } = await startCheckout();
  await payCallback(fields.InvId);

  const response = await request("/api/intake", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.31" },
    body: JSON.stringify(validIntake()),
  });
  assert.equal(response.status, 402);
});

test("intake refuses a submission for an unpaid order", async () => {
  const { cookie } = await startCheckout();
  const response = await request("/api/intake", {
    cookie,
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.32" },
    body: JSON.stringify(validIntake()),
  });
  assert.equal(response.status, 402);
});

function validIntake() {
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
  };
}

// --- mode handling --------------------------------------------------------

test("test mode sends IsTest=1", async () => {
  const { fields } = await startCheckout();
  assert.equal(fields.IsTest, "1");
});

test("live mode sends IsTest=0 and requires two explicit confirmations", async () => {
  process.env.ROBOKASSA_TEST_MODE = "false";
  process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "true";
  try {
    const { fields } = await startCheckout();
    assert.equal(fields.IsTest, "0");
  } finally {
    process.env.ROBOKASSA_TEST_MODE = "true";
    process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "false";
  }
});

test("an ambiguous mode flag closes the checkout instead of charging", async () => {
  process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "true";
  try {
    for (const value of ["True", "TRUE", "1", "yes", "false ", ""]) {
      process.env.ROBOKASSA_TEST_MODE = value;
      const response = await request("/api/payment/start?email=b%40example.ru");
      assert.equal(response.status, 303, `ROBOKASSA_TEST_MODE=${value}`);
      assert.equal(response.headers.get("location"), `${ORIGIN}/payment/unavailable`);
    }
    delete process.env.ROBOKASSA_TEST_MODE;
    const unset = await request("/api/payment/start?email=b%40example.ru");
    assert.equal(unset.status, 303);
    assert.equal((await orderRows()).length, 0, "a closed checkout must not create orders");
  } finally {
    process.env.ROBOKASSA_TEST_MODE = "true";
    process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "false";
  }
});

test("checkout stays closed when no order store is configured", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const response = await request("/api/payment/start?email=b%40example.ru");
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${ORIGIN}/payment/unavailable`);
  } finally {
    process.env.DATABASE_URL = previous;
  }
});

// --- security retest: multi-order browsers --------------------------------

test("restarting checkout keeps the session, so paying the first attempt still grants access", async () => {
  // Found while attacking the flow: a fresh secret on every attempt orphaned
  // the earlier order, and a customer who pressed back and then completed the
  // first Robokassa page was locked out of what they had paid for.
  const first = await startCheckout();
  const second = await request("/api/payment/start?email=buyer%40example.ru", {
    cookie: first.cookie,
  });
  const secondFields = readFormFields(await second.text());

  // The session is reused rather than replaced.
  assert.equal(second.headers.get("set-cookie")?.split(";")[0], first.cookie);
  assert.notEqual(secondFields.InvId, first.fields.InvId);
  assert.equal((await orderRows()).length, 2);

  // Pay the *first* attempt.
  await payCallback(first.fields.InvId);

  const html = await (await request("/payment/success", { cookie: first.cookie })).text();
  assert.match(html, /Платёж подтверждён/);
  assert.match(await (await request("/brief", { cookie: first.cookie })).text(), /Единая точка старта/);

  // Still exactly one entitlement, for the order that was actually paid.
  const grants = await grantRows();
  assert.equal(grants.length, 1);
  const paidOrder = (await orderRows()).find((o) => o.status === "paid");
  assert.equal(grants[0].order_id, paidOrder.id);
});

test("checkout cannot be replayed indefinitely to flood the orders table", async () => {
  // Creating an order is now a write, so an unbounded endpoint would let
  // anyone fill the table.
  let blocked = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request("/api/payment/start?email=flood%40example.ru", {
      headers: { "x-forwarded-for": "203.0.113.77" },
    });
    if (response.status === 303) blocked += 1;
  }
  assert.ok(blocked > 0, "the endpoint must start refusing");
  const created = (await orderRows()).length;
  assert.ok(created <= 20, `expected at most 20 orders, got ${created}`);
});

test("no password ever reaches the browser", async () => {
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);
  const secrets = new RegExp(`${PASSWORD_1}|${PASSWORD_2}`);

  for (const path of ["/payment/success", "/brief"]) {
    assert.doesNotMatch(await (await request(path, { cookie })).text(), secrets, path);
  }
});
