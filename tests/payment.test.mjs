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
  // `headers` is pulled out of the rest before spreading: leaving it in would
  // let `...rest` replace the merged header object wholesale and silently drop
  // the cookie, which made paid-access tests pass for the wrong reason.
  const { cookie, headers, ...rest } = init;
  return instance.fetch(
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

/** Applies a response's Set-Cookie headers on top of an existing jar. */
function mergeCookies(previous, response) {
  const jar = new Map(
    (previous ? previous.split("; ") : []).map((pair) => {
      const at = pair.indexOf("=");
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
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
  const setCookie = response.headers.getSetCookie().join(" | ");
  return { fields: readFormFields(await response.text()), cookie: cookieHeader(response), setCookie };
}

/**
 * Performs the same transaction the administrative tool performs, using the
 * in-process PGlite handle. The tool itself — argument handling, refusals,
 * output — is covered end-to-end in tests/bank-payment.test.mjs; here the
 * point is what a confirmed bank payment means for access.
 */
async function confirmBankPayment(invoiceId) {
  const { rows: claimed } = await testDb.db.query(
    `UPDATE orders SET status = 'paid', paid_at = now()
      WHERE invoice_id = ${invoiceId} AND status = 'awaiting_bank_payment'
      RETURNING id, paid_at, plan`,
  );
  if (claimed.length === 0) return false;
  const [order] = claimed;
  await testDb.db.query(
    `INSERT INTO access_grants (order_id, valid_from, valid_until)
     VALUES (${order.id}, '${new Date(order.paid_at).toISOString()}',
             '${new Date(order.paid_at).toISOString()}'::timestamptz
               + (${order.plan === "subscription" ? 30 : 7} || ' days')::interval)
     ON CONFLICT (order_id) DO NOTHING`,
  );
  return true;
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

test("a spent entitlement shows the completed state, not a demand to pay", async () => {
  // Telling someone who has just sent their form to pay first reads as though
  // their money vanished. The page must tell the three cases apart.
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);
  await testDb.db.query("UPDATE access_grants SET used_at = now()");

  const html = await (await request("/brief", { cookie })).text();
  assert.match(html, /Анкета уже отправлена/);
  assert.match(html, /Мы получили данные/);
  assert.doesNotMatch(html, /Анкета доступна после оплаты/);
  assert.doesNotMatch(html, /form class="brief-form"/);
  // Step 3 is reached: two ticks and "Готово" as the current step.
  assert.match(html, /step done[\s\S]*step done[\s\S]*step active/);
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

// --- buyer type and receipt requisites ------------------------------------

// A real INN carries a checksum, so these are computed rather than invented.
const ORG_INN = "7707083893"; // 10 digits, valid control digit
const SOLE_TRADER_INN = "500100732259"; // 12 digits, valid control digits

test("an individual buyer needs no tax details and stores none", async () => {
  await startCheckout("email=buyer%40example.ru&buyerType=individual");
  const [order] = await orderRows();
  assert.equal(order.buyer_type, "individual");
  assert.equal(order.buyer_inn, null);
  assert.equal(order.buyer_name, null);
});

test("an omitted buyer type falls back to individual", async () => {
  await startCheckout("email=buyer%40example.ru");
  const [order] = await orderRows();
  assert.equal(order.buyer_type, "individual");
});

test("an organisation buyer stores its name and INN", async () => {
  // Business checkouts redirect to the invoice page rather than to Robokassa.
  await request(
    `/api/payment/start?email=buyer%40example.ru&buyerType=business&buyerInn=${ORG_INN}` +
      "&buyerName=%D0%9E%D0%9E%D0%9E%20%C2%AB%D0%A0%D0%BE%D0%BC%D0%B0%D1%88%D0%BA%D0%B0%C2%BB",
  );
  const [order] = await orderRows();
  assert.equal(order.buyer_type, "business");
  assert.equal(order.buyer_inn, ORG_INN);
  assert.equal(order.buyer_name, "ООО «Ромашка»");
});

test("a sole trader buyer with a 12-digit INN is accepted", async () => {
  await request(
    `/api/payment/start?email=ip%40example.ru&buyerType=business&buyerInn=${SOLE_TRADER_INN}` +
      "&buyerName=%D0%98%D0%9F%20%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2",
  );
  const [order] = await orderRows();
  assert.equal(order.buyer_type, "business");
  assert.equal(order.buyer_inn, SOLE_TRADER_INN);
  assert.equal(order.buyer_name, "ИП Иванов");
});

test("a business buyer without an INN is refused and no order is created", async () => {
  const response = await request(
    "/api/payment/start?email=b%40example.ru&buyerType=business&buyerName=%D0%9E%D0%9E%D0%9E",
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${ORIGIN}/payment?error=inn`);
  assert.equal((await orderRows()).length, 0);
});

test("a business buyer without a name is refused", async () => {
  const response = await request(
    `/api/payment/start?email=b%40example.ru&buyerType=business&buyerInn=${ORG_INN}`,
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${ORIGIN}/payment?error=name`);
  assert.equal((await orderRows()).length, 0);
});

test("a malformed INN is refused, including one with a wrong checksum", async () => {
  const rejected = [
    "123", // too short
    "12345678901", // 11 digits, neither length
    "0000000000", // right length, wrong control digit
    "7707083894", // one digit off a real INN
    "500100732258", // 12 digits, wrong second control digit
    "77070838aa", // not digits
    "770708389%20", // trailing space
  ];
  for (const inn of rejected) {
    await testDb.reset();
    const response = await request(
      `/api/payment/start?email=b%40example.ru&buyerType=business&buyerInn=${inn}` +
        "&buyerName=%D0%9E%D0%9E%D0%9E",
    );
    assert.equal(response.headers.get("location"), `${ORIGIN}/payment?error=inn`, inn);
    assert.equal((await orderRows()).length, 0, inn);
  }
});

test("a tampered buyer type can only downgrade to individual, never skip requisites", async () => {
  // Anything that is not the literal "business" is an individual buyer, so
  // spoofing the field cannot produce a business order without tax details.
  for (const spoof of ["BUSINESS", "Business", "company", "1", "true", "', 'x"]) {
    await testDb.reset();
    const { fields } = await startCheckout(
      `email=b%40example.ru&buyerType=${encodeURIComponent(spoof)}`,
    );
    assert.ok(fields.InvId, spoof);
    const [order] = await orderRows();
    assert.equal(order.buyer_type, "individual", spoof);
    assert.equal(order.buyer_inn, null, spoof);
  }
});

test("the database refuses a business order with no requisites", async () => {
  // The pairing is a data constraint, not only a validator rule.
  await assert.rejects(
    () =>
      testDb.db.query(
        `INSERT INTO orders (invoice_id, plan, expected_amount, email, session_hash, buyer_type)
         VALUES (424242, 'pilot', 4900.00, 'x@example.ru', 'hash', 'business')`,
      ),
    /orders_buyer_requisites|check constraint/i,
  );

  // …and an individual order carrying stray tax details.
  await assert.rejects(
    () =>
      testDb.db.query(
        `INSERT INTO orders (invoice_id, plan, expected_amount, email, session_hash, buyer_type, buyer_inn, buyer_name)
         VALUES (424243, 'pilot', 4900.00, 'x@example.ru', 'hash', 'individual', '7707083893', 'ООО')`,
      ),
    /orders_buyer_requisites|check constraint/i,
  );
});

test("the receipt describes the service being sold", async () => {
  const { fields } = await startCheckout();
  const receipt = JSON.parse(decodeURIComponent(fields.Receipt));

  assert.equal(receipt.items.length, 1);
  const [item] = receipt.items;
  assert.match(item.name, /калибровк/i, "the line item must name the service");
  assert.ok(item.name.length <= 128);
  assert.equal(item.quantity, 1);
  assert.equal(item.sum, 4900);
  // Unchanged on purpose: a self-employed seller charges no VAT, and these
  // values were verified working end-to-end in test mode.
  assert.equal(item.tax, "none");
  assert.equal(item.payment_method, "full_prepayment");
  assert.equal(item.payment_object, "service");
  // The receipt total must equal what Robokassa is asked to charge.
  assert.equal(item.sum, Number(fields.OutSum));
});

// --- business flow: bank transfer, never Robokassa ------------------------

const BUSINESS_QUERY =
  `buyerType=business&buyerInn=${ORG_INN}` +
  "&buyerName=%D0%9E%D0%9E%D0%9E%20%C2%AB%D0%A0%D0%BE%D0%BC%D0%B0%D1%88%D0%BA%D0%B0%C2%BB";

/** Starts a business checkout and returns the order plus the session cookie. */
async function startBusinessCheckout(extra = "") {
  const response = await request(
    `/api/payment/start?email=buyer%40company.ru&${BUSINESS_QUERY}${extra}`,
  );
  assert.equal(response.status, 303, "a business checkout must not render a Robokassa form");
  const cookie = cookieHeader(response);
  return { response, cookie };
}

test("an individual checkout still goes to Robokassa", async () => {
  const { fields } = await startCheckout("email=buyer%40example.ru&buyerType=individual");
  assert.ok(fields.SignatureValue, "the card flow must still be signed");
  assert.equal(fields.OutSum, PILOT_AMOUNT);
  const [order] = await orderRows();
  assert.equal(order.status, "pending");
});

test("a business checkout never reaches Robokassa", async () => {
  const { response } = await startBusinessCheckout();
  assert.equal(response.headers.get("location"), `${ORIGIN}/payment/invoice`);

  const body = await response.text();
  assert.doesNotMatch(body, /robokassa/i, "no Robokassa form may be rendered");
  assert.doesNotMatch(body, /SignatureValue/, "no payment signature may be produced");
  assert.doesNotMatch(body, /Receipt/, "no receipt may be built for a business buyer");
});

test("a business order waits for a bank transfer", async () => {
  await startBusinessCheckout();
  const [order] = await orderRows();
  assert.equal(order.status, "awaiting_bank_payment");
  assert.equal(order.buyer_type, "business");
  assert.equal(order.buyer_inn, ORG_INN);
  assert.equal(order.expected_amount, PILOT_AMOUNT);
  assert.equal(order.paid_at, null);
  assert.equal((await grantRows()).length, 0);
});

test("the invoice page shows the order and refuses a stranger", async () => {
  const { cookie } = await startBusinessCheckout();
  const [order] = await orderRows();

  const html = await (await request("/payment/invoice", { cookie })).text();
  assert.match(html, /Оплата для ИП и организаций/);
  assert.match(html, new RegExp(String(order.invoice_id)));
  assert.match(html, /4\s?900/);
  assert.match(html, /калибровк/i);
  assert.match(html, new RegExp(ORG_INN));
  assert.match(html, /Ожидает оплаты/);

  const anonymous = await (await request("/payment/invoice")).text();
  assert.match(anonymous, /Счёт не сформирован/);
  assert.doesNotMatch(anonymous, new RegExp(String(order.invoice_id)));
});

test("a business checkout is not blocked by Robokassa being misconfigured", async () => {
  // The card rail is unrelated to a bank transfer, so an unusable Robokassa
  // configuration must not stop an organisation from ordering.
  process.env.ROBOKASSA_TEST_MODE = "nonsense";
  try {
    const { response } = await startBusinessCheckout();
    assert.equal(response.headers.get("location"), `${ORIGIN}/payment/invoice`);
    const [order] = await orderRows();
    assert.equal(order.status, "awaiting_bank_payment");
  } finally {
    process.env.ROBOKASSA_TEST_MODE = "true";
  }
});

test("a Robokassa callback can never settle a business order", async () => {
  const { cookie } = await startBusinessCheckout();
  const [order] = await orderRows();
  const invoiceId = String(order.invoice_id);

  // Correctly signed with Password#2, exactly as Robokassa would send it.
  const response = await payCallback(invoiceId);
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /^OK/);

  const [after] = await orderRows();
  assert.equal(after.status, "awaiting_bank_payment", "status must not move");
  assert.equal(after.paid_at, null);
  assert.equal((await grantRows()).length, 0, "no entitlement may be created");

  // And the brief stays shut.
  assert.match(await (await request("/brief", { cookie })).text(), /Анкета доступна после оплаты/);
});

test("manual confirmation settles a business order and grants access once", async () => {
  const { cookie } = await startBusinessCheckout();
  const [order] = await orderRows();
  const invoiceId = String(order.invoice_id);

  assert.equal(await confirmBankPayment(invoiceId), true);

  const [paid] = await orderRows();
  assert.equal(paid.status, "paid");
  assert.ok(paid.paid_at);

  const grants = await grantRows();
  assert.equal(grants.length, 1);
  assert.equal(grants[0].order_id, paid.id);
  // The same seven-day window individuals get, measured from the confirmation.
  const days = (new Date(grants[0].valid_until) - new Date(grants[0].valid_from)) / 86_400_000;
  assert.equal(Math.round(days), 7);
  assert.equal(
    new Date(grants[0].valid_from).getTime(),
    new Date(paid.paid_at).getTime(),
    "access must run from the confirmed payment",
  );

  // Access now works exactly as it does for a card payment.
  assert.match(await (await request("/brief", { cookie })).text(), /Единая точка старта/);
  assert.match(await (await request("/payment/invoice", { cookie })).text(), /Оплата получена/);
});

test("repeating the confirmation changes nothing and creates no second grant", async () => {
  await startBusinessCheckout();
  const [order] = await orderRows();
  const invoiceId = String(order.invoice_id);

  await confirmBankPayment(invoiceId);
  const [before] = await grantRows();
  const [paidOnce] = await orderRows();

  // A second confirmation matches no pending row, so it is a no-op.
  assert.equal(await confirmBankPayment(invoiceId), false);

  const grants = await grantRows();
  const [paidTwice] = await orderRows();
  assert.equal(grants.length, 1);
  assert.equal(grants[0].id, before.id);
  assert.equal(
    new Date(paidTwice.paid_at).getTime(),
    new Date(paidOnce.paid_at).getTime(),
    "paid_at must not move",
  );
});

test("the bank-transfer transition cannot touch an individual order", async () => {
  // The predicate requires status 'awaiting_bank_payment', which a card order
  // never has, so the two rails cannot cross.
  const { fields } = await startCheckout();
  assert.equal(await confirmBankPayment(fields.InvId), false);

  const [order] = await orderRows();
  assert.equal(order.status, "pending");
  assert.equal((await grantRows()).length, 0);
});

// --- owner notification for business orders -------------------------------

const BOT_TOKEN = "123456789:AAFakeTokenForTestsOnly-0123456789ab";

/**
 * Captures Telegram calls instead of making them. Nothing leaves the process:
 * every other fetch still goes to the real implementation, which in these
 * tests is never exercised.
 */
function interceptTelegram({ ok = true, throws = false } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("api.telegram.org")) {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      if (throws) throw new Error("network is down");
      return new Response(JSON.stringify({ ok }), {
        status: ok ? 200 : 500,
        headers: { "content-type": "application/json" },
      });
    }
    return original(input, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function withTelegram(options, body) {
  const previous = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chat: process.env.TELEGRAM_OWNER_CHAT_ID,
    relay: process.env.TELEGRAM_RELAY_URL,
  };
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_OWNER_CHAT_ID = "555000";
  delete process.env.TELEGRAM_RELAY_URL;

  const telegram = interceptTelegram(options);
  try {
    return await body(telegram);
  } finally {
    telegram.restore();
    for (const [key, value] of [
      ["TELEGRAM_BOT_TOKEN", previous.token],
      ["TELEGRAM_OWNER_CHAT_ID", previous.chat],
      ["TELEGRAM_RELAY_URL", previous.relay],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a business order notifies the owner with everything needed to raise an invoice", async () => {
  await withTelegram({}, async (telegram) => {
    await startBusinessCheckout();
    const [order] = await orderRows();

    assert.equal(telegram.calls.length, 1, "exactly one message");
    const { url, body } = telegram.calls[0];
    assert.match(url, /\/sendMessage$/);
    assert.equal(body.chat_id, "555000");

    const text = body.text;
    assert.match(text, new RegExp(String(order.invoice_id)));
    assert.match(text, /ООО «Ромашка»/);
    assert.match(text, new RegExp(ORG_INN));
    assert.match(text, /buyer@company\.ru/);
    assert.match(text, /калибровк/i);
    assert.match(text, /4900\.00/);
    assert.match(text, /awaiting_bank_payment/);
  });
});

test("the notification carries no secrets", async () => {
  await withTelegram({}, async (telegram) => {
    await startBusinessCheckout();
    const [order] = await orderRows();
    const { text } = telegram.calls[0].body;

    for (const secret of [
      order.session_hash,
      PASSWORD_1,
      PASSWORD_2,
      BOT_TOKEN,
      testDb.url,
      "postgresql://",
    ]) {
      assert.ok(!text.includes(secret), `notification leaked ${secret.slice(0, 12)}…`);
    }
  });
});

test("an individual order sends no owner notification", async () => {
  await withTelegram({}, async (telegram) => {
    await startCheckout("email=buyer%40example.ru&buyerType=individual");
    assert.equal(telegram.calls.length, 0, "the card flow must stay silent");
  });
});

test("a rejected Telegram delivery still leaves the business order intact", async () => {
  await withTelegram({ ok: false }, async (telegram) => {
    const { response, cookie } = await startBusinessCheckout();

    assert.equal(telegram.calls.length, 1, "delivery was attempted");
    assert.equal(response.headers.get("location"), `${ORIGIN}/payment/invoice`);

    const [order] = await orderRows();
    assert.equal(order.status, "awaiting_bank_payment");
    assert.equal(order.buyer_inn, ORG_INN);

    // And the buyer can still see their invoice.
    const html = await (await request("/payment/invoice", { cookie })).text();
    assert.match(html, new RegExp(String(order.invoice_id)));
  });
});

test("a Telegram outage still leaves the business order intact", async () => {
  await withTelegram({ throws: true }, async (telegram) => {
    const { response } = await startBusinessCheckout();

    assert.equal(telegram.calls.length, 1);
    assert.equal(response.headers.get("location"), `${ORIGIN}/payment/invoice`);

    const orders = await orderRows();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].status, "awaiting_bank_payment");
  });
});

test("a business order is created even with no Telegram configured at all", async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const { response } = await startBusinessCheckout();
    assert.equal(response.headers.get("location"), `${ORIGIN}/payment/invoice`);
    const [order] = await orderRows();
    assert.equal(order.status, "awaiting_bank_payment");
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

test("a paid intake still reaches the owner through the shared sender", async () => {
  // Covers the delivery path that /api/intake shares with the checkout
  // notification, so the extraction into lib/telegram.ts stays verified.
  await withTelegram({}, async (telegram) => {
    const { fields, cookie } = await startCheckout();
    await payCallback(fields.InvId);

    const response = await request("/api/intake", {
      cookie,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validIntake()),
    });
    assert.equal(response.status, 201);

    assert.equal(telegram.calls.length, 1);
    const { text } = telegram.calls[0].body;
    assert.match(text, /Новая анкета/);
    assert.match(text, new RegExp(fields.InvId));

    // The entitlement is spent only once delivery succeeded.
    const [grant] = await grantRows();
    assert.ok(grant.used_at);
  });
});

test("a failed intake delivery reports an error and does not spend the entitlement", async () => {
  await withTelegram({ ok: false }, async (telegram) => {
    const { fields, cookie } = await startCheckout();
    await payCallback(fields.InvId);

    const response = await request("/api/intake", {
      cookie,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validIntake()),
    });
    assert.equal(response.status, 502);
    assert.equal(telegram.calls.length, 1);

    const [grant] = await grantRows();
    assert.equal(grant.used_at, null, "a paid customer must be able to retry");
  });
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
  const issued = second.headers.getSetCookie();
  const secondFields = readFormFields(await second.text());

  // The session secret is reused; only the selector moves to the new order.
  const checkoutCookie = first.cookie.split("; ").find((c) => c.startsWith("poztender_checkout="));
  assert.ok(issued.some((value) => value.startsWith(`${checkoutCookie};`)));
  assert.ok(issued.some((value) => value.startsWith(`poztender_order=${secondFields.InvId};`)));
  assert.notEqual(secondFields.InvId, first.fields.InvId);
  assert.equal((await orderRows()).length, 2);

  // Pay the *first* attempt. Its selector cookie is still the one the browser
  // held before the second checkout, which is what a customer returning from
  // the first Robokassa tab would send.
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

// --- stepper states -------------------------------------------------------

/** The three steps as rendered: done / active / upcoming, in order. */
function stepStates(html) {
  return [...html.matchAll(/class="step (done|active|upcoming)"/g)].map((m) => m[1]);
}

test("the invoice page steps forward once the bank transfer is confirmed", async () => {
  const { cookie } = await startBusinessCheckout();
  const [order] = await orderRows();

  const awaiting = await (await request("/payment/invoice", { cookie })).text();
  assert.deepEqual(stepStates(awaiting), ["active", "upcoming", "upcoming"]);
  assert.match(awaiting, /Ожидает оплаты/);

  await confirmBankPayment(String(order.invoice_id));

  const paid = await (await request("/payment/invoice", { cookie })).text();
  assert.deepEqual(stepStates(paid), ["done", "active", "upcoming"]);
  assert.match(paid, /Оплата получена/);
  assert.match(paid, /Перейти к анкете/);
});

test("a paid subscription invoice never points at the intake form", async () => {
  const { cookie } = await startBusinessCheckout("&plan=subscription");
  const [order] = await orderRows();
  await confirmBankPayment(String(order.invoice_id));

  const html = await (await request("/payment/invoice", { cookie })).text();
  assert.match(html, /Оплата получена/);
  assert.match(html, /Обслуживание продлено/);
  assert.doesNotMatch(html, /href="\/brief"/, "a renewal must not be sent to a form it cannot use");
});

test("the success page steps forward once the callback lands", async () => {
  const { fields, cookie } = await startCheckout();

  const processing = await (await request("/payment/success", { cookie })).text();
  assert.deepEqual(stepStates(processing), ["active", "upcoming", "upcoming"]);
  assert.match(processing, /Платёж обрабатывается/);

  await payCallback(fields.InvId);

  const paid = await (await request("/payment/success", { cookie })).text();
  assert.deepEqual(stepStates(paid), ["done", "active", "upcoming"]);
  assert.match(paid, /Платёж подтверждён/);
});

test("a confirmed subscription shows the final step", async () => {
  const { fields, cookie } = await startCheckout("plan=subscription&email=b%40example.ru");
  await payCallback(fields.InvId, SUBSCRIPTION_AMOUNT);

  const html = await (await request("/payment/success", { cookie })).text();
  assert.deepEqual(stepStates(html), ["done", "done", "active"]);
  assert.match(html, /Продление подтверждено/);
});

test("only the current step is marked as such for assistive technology", async () => {
  const { cookie } = await startCheckout();
  const html = await (await request("/payment/success", { cookie })).text();
  assert.equal((html.match(/aria-current="step"/g) ?? []).length, 1);
});

test("submitting the intake advances to the final step and survives a refresh", async () => {
  await withTelegram({}, async () => {
    const { fields, cookie } = await startCheckout();
    await payCallback(fields.InvId);

    const open = await (await request("/brief", { cookie })).text();
    assert.deepEqual(stepStates(open), ["done", "active", "upcoming"]);

    const response = await request("/api/intake", {
      cookie,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validIntake()),
    });
    assert.equal(response.status, 201);

    // Refreshing is what used to destroy the completed state; now the server
    // knows the grant was spent and says so.
    for (let visit = 0; visit < 2; visit += 1) {
      const done = await (await request("/brief", { cookie })).text();
      assert.deepEqual(stepStates(done), ["done", "done", "active"]);
      assert.match(done, /Анкета уже отправлена/);
      assert.doesNotMatch(done, /Анкета доступна после оплаты/);
    }
  });
});

test("an unpaid visitor sees the payment-required state at step one", async () => {
  const html = await (await request("/brief")).text();
  assert.deepEqual(stepStates(html), ["active", "upcoming", "upcoming"]);
  assert.match(html, /Анкета доступна после оплаты/);
});

// --- regression: a browser that already owns an order ----------------------

test("REGRESSION: a new business order opens its invoice even if the browser already paid for something", async () => {
  // /api/payment/start reuses the browser's existing checkout secret, so both
  // orders end up sharing one session_hash. findOrderForCookie then prefers the
  // *paid* order, and /payment/invoice — which only accepts a business order —
  // gets handed the older individual one and reports "Счёт не сформирован".
  const { fields, cookie } = await startCheckout("email=person%40example.ru&buyerType=individual");
  await payCallback(fields.InvId);

  const second = await request(
    `/api/payment/start?email=repro%40company.ru&${BUSINESS_QUERY}`,
    { cookie },
  );
  assert.equal(second.status, 303);
  assert.equal(second.headers.get("location"), `${ORIGIN}/payment/invoice`);
  // What the browser now holds: same secret, selector moved to the new order.
  const jar = mergeCookies(cookie, second);

  const orders = await orderRows();
  const business = orders.find((o) => o.buyer_type === "business");
  assert.ok(business, "the business order was created");
  assert.equal(business.status, "awaiting_bank_payment");
  assert.equal(
    orders[0].session_hash,
    business.session_hash,
    "both orders share one session, which is what triggers the bug",
  );

  const html = await (await request("/payment/invoice", { cookie: jar })).text();
  assert.match(html, /Оплата для ИП и организаций/);
  assert.match(html, new RegExp(String(business.invoice_id)));
  assert.doesNotMatch(html, /Счёт не сформирован/);
});

// --- the selected order, and why the invoice number is not a credential ----

test("B: a new individual order shows its own state, not the earlier paid one", async () => {
  const first = await startCheckout("email=one%40example.ru&buyerType=individual");
  await payCallback(first.fields.InvId);

  const second = await request("/api/payment/start?email=two%40example.ru&buyerType=individual", {
    cookie: first.cookie,
  });
  const secondFields = readFormFields(await second.text());
  const jar = mergeCookies(first.cookie, second);

  // Back from Robokassa before the callback lands.
  const before = await (await request("/payment/success", { cookie: jar })).text();
  assert.match(before, /Платёж обрабатывается/, "the new order is still pending");
  assert.doesNotMatch(before, /Платёж подтверждён/, "the older paid order must not be shown");

  await payCallback(secondFields.InvId);
  assert.match(
    await (await request("/payment/success", { cookie: jar })).text(),
    /Платёж подтверждён/,
  );
});

test("C: two business orders in a row — the invoice shows the one just created", async () => {
  const first = await startBusinessCheckout();
  const firstOrder = (await orderRows())[0];

  const second = await request(
    `/api/payment/start?email=second%40company.ru&${BUSINESS_QUERY}`,
    { cookie: first.cookie },
  );
  const jar = mergeCookies(first.cookie, second);
  const orders = await orderRows();
  const secondOrder = orders.find((o) => o.id !== firstOrder.id);

  // Both are business and both awaiting payment, so no ranking could tell them
  // apart — only the selector can.
  assert.equal(orders.length, 2);
  assert.equal(secondOrder.status, "awaiting_bank_payment");

  const html = await (await request("/payment/invoice", { cookie: jar })).text();
  assert.match(html, new RegExp(String(secondOrder.invoice_id)));
  assert.doesNotMatch(html, new RegExp(String(firstOrder.invoice_id)));
});

test("G: a forged selector for someone else's order is refused", async () => {
  // Victim's order, in a different browser.
  const victim = await startBusinessCheckout();
  const victimOrder = (await orderRows())[0];

  // Attacker's own session, pointed at the victim's invoice number.
  const attacker = await startCheckout("email=attacker%40example.ru&buyerType=individual");
  const attackerSecret = attacker.cookie
    .split("; ")
    .find((c) => c.startsWith("poztender_checkout="));

  const forged = `${attackerSecret}; poztender_order=${victimOrder.invoice_id}`;
  const html = await (await request("/payment/invoice", { cookie: forged })).text();
  assert.match(html, /Счёт не сформирован/);
  assert.doesNotMatch(html, new RegExp(String(victimOrder.invoice_id)));

  // And the victim's own jar still works, so the refusal is about ownership.
  assert.match(
    await (await request("/payment/invoice", { cookie: victim.cookie })).text(),
    new RegExp(String(victimOrder.invoice_id)),
  );
});

test("the invoice number alone opens nothing", async () => {
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);

  const secret = cookie.split("; ").find((c) => c.startsWith("poztender_checkout="));
  const selector = `poztender_order=${fields.InvId}`;

  // Selector without a session: refused.
  assert.match(
    await (await request("/brief", { cookie: selector })).text(),
    /Анкета доступна после оплаты/,
  );
  // Session without a selector: refused, because nothing names the order.
  assert.match(
    await (await request("/brief", { cookie: secret })).text(),
    /Анкета доступна после оплаты/,
  );
  // Both together: allowed.
  assert.match(
    await (await request("/brief", { cookie: `${secret}; ${selector}` })).text(),
    /Единая точка старта/,
  );
});

test("a malformed selector is refused rather than guessed around", async () => {
  const { fields, cookie } = await startCheckout();
  await payCallback(fields.InvId);
  const secret = cookie.split("; ").find((c) => c.startsWith("poztender_checkout="));

  // Surrounding whitespace is stripped per RFC 6265, so a padded value is the
  // same selector — and still subject to the ownership check.
  for (const value of ["abc", "-1", "0", "1.5", "", "99999999999999999999", "0x1f"]) {
    const html = await (
      await request("/brief", { cookie: `${secret}; poztender_order=${value}` })
    ).text();
    assert.match(html, /Анкета доступна после оплаты/, `selector=${value}`);
  }
});

test("a new checkout does not hand the previous order's entitlement to the new one", async () => {
  const first = await startCheckout();
  await payCallback(first.fields.InvId);
  assert.match(await (await request("/brief", { cookie: first.cookie })).text(), /Единая точка старта/);

  const second = await request("/api/payment/start?email=again%40example.ru", {
    cookie: first.cookie,
  });
  const jar = mergeCookies(first.cookie, second);

  // The new order is unpaid, so the old grant must not carry over to it.
  assert.match(
    await (await request("/brief", { cookie: jar })).text(),
    /Анкета доступна после оплаты/,
  );
  // Only one grant exists throughout.
  assert.equal((await grantRows()).length, 1);
});

