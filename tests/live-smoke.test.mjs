// The temporary ten-rouble live smoke tariff.
//
// The first real card payment through production should cost ten roubles, not
// a full tariff, so `plan=live-smoke` buys a 10.00 order through the ordinary
// pipeline: the same orders table, the same ResultURL signed with Password#2,
// the same conditional paid transition, the same access_grant and recovery
// email. There is no second callback and no shortcut around any of it.
//
// It is not a product. Nothing links to it, and it exists only while
// ROBOKASSA_LIVE_SMOKE_TEST is exactly "true" — one variable turns it off
// again without touching a price.
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
const SMOKE_AMOUNT = "10.00";
// Its own port band — see the note in tests/intake-submission.test.mjs.
const DB_PORT = 56_700 + (process.pid % 200);

let testDb;
let worker;

before(async () => {
  testDb = await startTestDatabase(DB_PORT);
  process.env.DATABASE_URL = testDb.url;
  process.env.DATABASE_POOL_MAX = "1";
  process.env.ROBOKASSA_MERCHANT_LOGIN = MERCHANT_LOGIN;
  process.env.ROBOKASSA_PASSWORD_1 = PASSWORD_1;
  process.env.ROBOKASSA_PASSWORD_2 = PASSWORD_2;
  process.env.ROBOKASSA_TEST_MODE = "true";
  process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "false";
  delete process.env.ROBOKASSA_LIVE_SMOKE_TEST;

  const url = new URL("../dist/server/index.js", import.meta.url);
  worker = await import(url.href).then((module) => module.default);
});

after(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.reset();
  delete process.env.ROBOKASSA_LIVE_SMOKE_TEST;
});

let clientCounter = 0;
async function request(path, init = {}) {
  clientCounter += 1;
  const { cookie, ...rest } = init;
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      ...rest,
      headers: {
        accept: "text/html",
        "x-forwarded-proto": "https",
        "x-forwarded-for": `198.18.1.${(clientCounter % 250) + 1}`,
        ...(cookie ? { cookie } : {}),
      },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const rows = async (sql) => (await testDb.db.query(sql)).rows;
const orderRows = () => rows("SELECT * FROM orders ORDER BY id");
const grantRows = () => rows("SELECT * FROM access_grants ORDER BY id");

function readFormFields(html) {
  const fields = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[match[1]] = match[2]
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  }
  return fields;
}

function enableSmoke(value = "true") {
  process.env.ROBOKASSA_LIVE_SMOKE_TEST = value;
}

async function startCheckout(query) {
  const response = await request(`/api/payment/start?${query}`);
  return { response, fields: response.status === 200 ? readFormFields(await response.text()) : null };
}

// --- 1. the flag is the whole gate ---------------------------------------

test("without the flag the smoke plan does not exist", async () => {
  const { response } = await startCheckout("plan=live-smoke&email=owner%40poztender.ru");

  assert.equal(response.status, 404, "an unknown tariff must look unknown");
  assert.equal((await orderRows()).length, 0, "no order may be written");
});

for (const value of ["false", "TRUE", "True", "1", "yes", " true", ""]) {
  test(`the flag set to ${JSON.stringify(value)} still refuses the smoke plan`, async () => {
    enableSmoke(value);
    const { response } = await startCheckout("plan=live-smoke&email=owner%40poztender.ru");

    assert.equal(response.status, 404, "only the exact string \"true\" opens it");
    assert.equal((await orderRows()).length, 0);
  });
}

test("turning the flag off again closes it with no other change", async () => {
  enableSmoke();
  assert.equal((await startCheckout("plan=live-smoke&email=owner%40poztender.ru")).response.status, 200);

  delete process.env.ROBOKASSA_LIVE_SMOKE_TEST;
  assert.equal((await startCheckout("plan=live-smoke&email=owner%40poztender.ru")).response.status, 404);
});

test("a business smoke order is refused: that rail is bank transfer", async () => {
  enableSmoke();
  const { response } = await startCheckout(
    "plan=live-smoke&email=owner%40poztender.ru&buyerType=business&buyerInn=7707083893" +
      "&buyerName=%D0%9E%D0%9E%D0%9E%20%C2%AB%D0%A0%D0%BE%D0%BC%D0%B0%D1%88%D0%BA%D0%B0%C2%BB",
  );

  assert.equal(response.status, 404);
  assert.equal((await orderRows()).length, 0, "no business smoke order may be written");
});

// --- 2 & 3. the amount is the server's ------------------------------------

test("with the flag the amount is exactly 10.00", async () => {
  enableSmoke();
  const { response, fields } = await startCheckout("plan=live-smoke&email=owner%40poztender.ru");

  assert.equal(response.status, 200);
  assert.equal(fields.OutSum, SMOKE_AMOUNT);

  const [order] = await orderRows();
  assert.equal(order.plan, "live-smoke");
  assert.equal(order.expected_amount, SMOKE_AMOUNT);
  assert.equal(order.status, "pending");
  assert.equal(order.buyer_type, "individual");
});

test("the browser cannot move the smoke amount", async () => {
  enableSmoke();
  const { fields } = await startCheckout(
    "plan=live-smoke&email=owner%40poztender.ru&amount=1.00&OutSum=99999.00&expectedAmount=1",
  );

  assert.equal(fields.OutSum, SMOKE_AMOUNT, "the price comes from the plan, not the query");
  const [order] = await orderRows();
  assert.equal(order.expected_amount, SMOKE_AMOUNT);
});

test("an unknown plan is still pilot, never the smoke tariff", async () => {
  enableSmoke();
  for (const plan of ["", "smoke", "live_smoke", "LIVE-SMOKE", "10.00"]) {
    await testDb.reset();
    const { fields } = await startCheckout(`plan=${encodeURIComponent(plan)}&email=b%40example.ru`);
    assert.equal(fields.OutSum, PILOT_AMOUNT, `plan=${JSON.stringify(plan)} must fall back to pilot`);
  }
});

// --- 4. the receipt ------------------------------------------------------

test("the smoke receipt is 10.00 with a neutral name", async () => {
  enableSmoke();
  const { fields } = await startCheckout("plan=live-smoke&email=owner%40poztender.ru");

  const receipt = JSON.parse(decodeURIComponent(fields.Receipt));
  assert.equal(receipt.items.length, 1);
  assert.equal(receipt.items[0].sum, 10);
  assert.equal(receipt.items[0].quantity, 1);
  assert.equal(receipt.items[0].name, "Проверка подключения платежного сервиса ПожТендер");
  // Fiscal attributes are the same as every other order: nothing about the
  // smoke tariff changes how a receipt is issued.
  assert.equal(receipt.items[0].tax, "none");
  assert.equal(receipt.items[0].payment_method, "full_prepayment");
  assert.equal(receipt.items[0].payment_object, "service");

  // And the signature is the ordinary one, over the ordinary base.
  assert.equal(
    fields.SignatureValue,
    sha256(`${fields.MerchantLogin}:${fields.OutSum}:${fields.InvId}:${fields.Receipt}:${PASSWORD_1}`),
  );
});

// --- 5. the ordinary ResultURL settles it ---------------------------------

test("ResultURL settles a smoke order and creates a grant like any other", async () => {
  enableSmoke();
  const { fields } = await startCheckout("plan=live-smoke&email=owner%40poztender.ru");
  const { InvId } = fields;

  // Password#1 must not settle a callback, exactly as for a real tariff.
  const forged = await request(
    `/api/payment/result?OutSum=${SMOKE_AMOUNT}&InvId=${InvId}` +
      `&SignatureValue=${sha256(`${SMOKE_AMOUNT}:${InvId}:${PASSWORD_1}`)}`,
  );
  assert.equal(forged.status, 403);
  assert.equal((await grantRows()).length, 0);

  const settled = await request(
    `/api/payment/result?OutSum=${SMOKE_AMOUNT}&InvId=${InvId}` +
      `&SignatureValue=${sha256(`${SMOKE_AMOUNT}:${InvId}:${PASSWORD_2}`)}`,
  );
  assert.equal(await settled.text(), `OK${InvId}`);

  const [order] = await orderRows();
  assert.equal(order.status, "paid");
  assert.ok(order.paid_at);

  const [grant] = await grantRows();
  assert.ok(grant, "a smoke payment earns a grant through the ordinary transaction");
  assert.equal(grant.used_at, null);
  const days = (new Date(grant.valid_until) - new Date(grant.valid_from)) / 86_400_000;
  assert.equal(Math.round(days), 1, "the smoke grant is short-lived");
});

test("a smoke order cannot be settled at some other amount", async () => {
  enableSmoke();
  const { fields } = await startCheckout("plan=live-smoke&email=owner%40poztender.ru");
  const { InvId } = fields;

  const wrongAmount = await request(
    `/api/payment/result?OutSum=${PILOT_AMOUNT}&InvId=${InvId}` +
      `&SignatureValue=${sha256(`${PILOT_AMOUNT}:${InvId}:${PASSWORD_2}`)}`,
  );
  assert.notEqual(await wrongAmount.text(), `OK${InvId}`);

  const [order] = await orderRows();
  assert.equal(order.status, "pending", "the order keeps its own expected amount");
  assert.equal((await grantRows()).length, 0);
});

test("a paid smoke order still settles after the flag is turned off", async () => {
  // Money that has arrived cannot be un-arrived by an environment variable.
  enableSmoke();
  const { fields } = await startCheckout("plan=live-smoke&email=owner%40poztender.ru");
  const { InvId } = fields;
  delete process.env.ROBOKASSA_LIVE_SMOKE_TEST;

  const settled = await request(
    `/api/payment/result?OutSum=${SMOKE_AMOUNT}&InvId=${InvId}` +
      `&SignatureValue=${sha256(`${SMOKE_AMOUNT}:${InvId}:${PASSWORD_2}`)}`,
  );
  assert.equal(await settled.text(), `OK${InvId}`);
  assert.equal((await orderRows())[0].status, "paid");
  assert.equal((await grantRows()).length, 1);
});

test("a smoke grant does not open the intake form", async () => {
  enableSmoke();
  const response = await request("/api/payment/start?plan=live-smoke&email=owner%40poztender.ru");
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const { InvId } = readFormFields(await response.text());
  await request(
    `/api/payment/result?OutSum=${SMOKE_AMOUNT}&InvId=${InvId}` +
      `&SignatureValue=${sha256(`${SMOKE_AMOUNT}:${InvId}:${PASSWORD_2}`)}`,
  );

  // /brief belongs to a paid pilot. A ten-rouble rail check must not buy it.
  const brief = await request("/brief", { cookie });
  const html = await brief.text();
  assert.doesNotMatch(html, /Единая точка старта/, "the smoke order buys no intake form");
});

// --- 6. the real tariffs are untouched ------------------------------------

test("the real tariffs are unchanged, with and without the flag", async () => {
  for (const flag of [undefined, "true"]) {
    if (flag) enableSmoke(flag);
    else delete process.env.ROBOKASSA_LIVE_SMOKE_TEST;

    await testDb.reset();
    const pilot = await startCheckout("email=buyer%40example.ru");
    assert.equal(pilot.fields.OutSum, PILOT_AMOUNT);
    assert.equal((await orderRows())[0].expected_amount, PILOT_AMOUNT);

    await testDb.reset();
    const subscription = await startCheckout("plan=subscription&email=buyer%40example.ru");
    assert.equal(subscription.fields.OutSum, SUBSCRIPTION_AMOUNT);
    assert.equal((await orderRows())[0].expected_amount, SUBSCRIPTION_AMOUNT);
  }
});

test("a pilot order still earns its seven-day grant while the flag is on", async () => {
  enableSmoke();
  const { fields } = await startCheckout("email=buyer%40example.ru");
  const { InvId } = fields;

  await request(
    `/api/payment/result?OutSum=${PILOT_AMOUNT}&InvId=${InvId}` +
      `&SignatureValue=${sha256(`${PILOT_AMOUNT}:${InvId}:${PASSWORD_2}`)}`,
  );

  const [grant] = await grantRows();
  const days = (new Date(grant.valid_until) - new Date(grant.valid_from)) / 86_400_000;
  assert.equal(Math.round(days), 7, "the pilot window must not have moved");
});

test("the smoke tariff is not advertised anywhere a customer looks", async () => {
  enableSmoke();
  for (const path of ["/", "/payment", "/renew"]) {
    const response = await request(path);
    if (response.status !== 200) continue;
    const html = await response.text();
    assert.doesNotMatch(html, /live-smoke/, `${path} must not offer the smoke tariff`);
    assert.doesNotMatch(html, /Проверка подключения платежного сервиса/, `${path} leaks the smoke product`);
  }
});
