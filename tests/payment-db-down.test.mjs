// What happens when the order store is unreachable.
//
// This lives in its own file because `node --test` gives each file a fresh
// process: the bundled `pg` pool is created once per process, so pointing
// DATABASE_URL at a closed port only produces a genuine connection failure if
// nothing has connected successfully first.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before } from "node:test";

const ORIGIN = "https://poztender.example";
const PASSWORD_2 = "fake-password-two";
const PILOT_AMOUNT = "4900.00";
const INVOICE_ID = "4503599627370495";

let worker;

before(async () => {
  // Port 1 is reserved and never listening, so the driver fails to connect.
  process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:1/postgres";
  process.env.DATABASE_POOL_MAX = "1";
  process.env.ROBOKASSA_MERCHANT_LOGIN = "poztender-test";
  process.env.ROBOKASSA_PASSWORD_1 = "fake-password-one";
  process.env.ROBOKASSA_PASSWORD_2 = PASSWORD_2;
  process.env.ROBOKASSA_TEST_MODE = "true";
  process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "false";

  const built = await import(new URL("../dist/server/index.js", import.meta.url).href);
  worker = built.default;
});

function request(path, init = {}) {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      headers: { accept: "text/html", "x-forwarded-proto": "https" },
      ...init,
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

const resultSignature = (outSum, invId) =>
  createHash("sha256").update(`${outSum}:${invId}:${PASSWORD_2}`, "utf8").digest("hex");

test("a correctly signed callback is never acknowledged while the database is down", async () => {
  // Answering OK here would tell Robokassa the order is settled while nothing
  // was recorded and the customer has no access. Failing loudly makes
  // Robokassa deliver the notification again instead.
  const response = await request(
    `/api/payment/result?OutSum=${PILOT_AMOUNT}&InvId=${INVOICE_ID}` +
      `&SignatureValue=${resultSignature(PILOT_AMOUNT, INVOICE_ID)}`,
  );

  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /^OK/);
});

test("checkout refuses to start a payment it cannot record", async () => {
  // DATABASE_URL is set but unreachable, so the failure surfaces when the
  // order is written. The customer goes back to the checkout with an
  // explanation rather than on to Robokassa with an unrecorded payment.
  const response = await request("/api/payment/start?email=buyer%40example.ru");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${ORIGIN}/payment?error=store`);

  const html = await (await request("/payment?error=store")).text();
  assert.match(html, /Не удалось начать оплату/);
});

test("the brief stays closed while the database is down", async () => {
  const html = await (await request("/brief")).text();
  assert.match(html, /Анкета доступна после оплаты/);
});
