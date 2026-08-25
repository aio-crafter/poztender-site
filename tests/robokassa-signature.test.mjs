// The outbound Robokassa payment signature.
//
// Live checkout reported error 29 — "invalid SignatureValue" — and until now
// nothing pinned the base string: the suite only asserted that a signature was
// produced. These tests recompute it independently from the fields the form
// actually POSTs, so the base and the payload can never drift apart again, and
// so any future change to the formula has to be a deliberate one.
//
// The contract asserted here is Robokassa's documented extended formula:
//
//   MerchantLogin:OutSum:InvId:Receipt:SuccessUrl2:SuccessUrl2Method
//     :FailUrl2:FailUrl2Method:Password#1
//
// The redirect URLs are in it because the form sends them as SuccessUrl2 and
// FailUrl2. Dropping them from the base while still sending those fields is
// the one combination the documentation rules out.
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
// Its own port band — see the note in tests/intake-submission.test.mjs.
const DB_PORT = 56_500 + (process.pid % 200);

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

  const url = new URL("../dist/server/index.js", import.meta.url);
  worker = await import(url.href).then((module) => module.default);
});

after(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.reset();
});

let clientCounter = 0;
async function request(path) {
  clientCounter += 1;
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      headers: {
        accept: "text/html",
        "x-forwarded-proto": "https",
        "x-forwarded-for": `198.18.0.${(clientCounter % 250) + 1}`,
      },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

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

async function checkout(query = "email=buyer%40example.ru") {
  const response = await request(`/api/payment/start?${query}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /action="https:\/\/auth\.robokassa\.ru\/Merchant\/Index\.aspx"/);
  return readFormFields(html);
}

/**
 * The documented base, rebuilt here from the fields the form really sends.
 *
 * Every URL-shaped value is percent-encoded, exactly as in Robokassa's own
 * worked example: `…:https%3A%2F%2Frobokassa.com%2F:GET:…`. The receipt is
 * already encoded when it reaches the form, so it is taken as-is.
 */
function signatureBase(fields, password = PASSWORD_1) {
  return [
    fields.MerchantLogin,
    fields.OutSum,
    fields.InvId,
    fields.Receipt,
    encodeURIComponent(fields.SuccessUrl2),
    fields.SuccessUrl2Method,
    encodeURIComponent(fields.FailUrl2),
    fields.FailUrl2Method,
    password,
  ].join(":");
}

// --- the base string ------------------------------------------------------

test("SignatureValue is sha256 of the documented base, rebuilt from the posted fields", async () => {
  const fields = await checkout();
  assert.equal(fields.SignatureValue, sha256(signatureBase(fields)));
});

test("the signature is computed over Password#1, never Password#2", async () => {
  const fields = await checkout();
  assert.notEqual(
    fields.SignatureValue,
    sha256(signatureBase(fields, PASSWORD_2)),
    "the checkout signature must not verify against the ResultURL password",
  );
});

test("no unsigned field can be swapped into the base without breaking it", async () => {
  const fields = await checkout();
  // Description, Email, Culture and IsTest are sent but do not participate.
  for (const name of ["Description", "Email", "Culture", "IsTest"]) {
    assert.ok(fields[name] !== undefined, `${name} must still be posted`);
    assert.ok(
      !signatureBase(fields).includes(`:${fields[name]}:`),
      `${name} must not be part of the signature base`,
    );
  }
});

// --- the form and the signature describe the same payment -----------------

test("OutSum, InvId and Receipt in the form are exactly what was signed", async () => {
  const fields = await checkout();

  // Rebuilding the base from the form and getting the same digest is only
  // possible if every signed field survived into the payload byte for byte.
  assert.equal(fields.SignatureValue, sha256(signatureBase(fields)));
  assert.equal(fields.OutSum, PILOT_AMOUNT);
  assert.match(fields.InvId, /^\d+$/);
  assert.ok(fields.Receipt.length > 0);
});

test("the amount in the form is the tariff, not anything the browser asked for", async () => {
  const inflated = await checkout("email=buyer%40example.ru&amount=1.00&OutSum=1.00");
  assert.equal(inflated.OutSum, PILOT_AMOUNT, "the price is decided by the server");
  assert.equal(inflated.SignatureValue, sha256(signatureBase(inflated)));

  const subscription = await checkout("plan=subscription&email=buyer%40example.ru");
  assert.equal(subscription.OutSum, SUBSCRIPTION_AMOUNT);
  assert.equal(subscription.SignatureValue, sha256(signatureBase(subscription)));
});

// --- Receipt --------------------------------------------------------------

test("Receipt is URL-encoded, and the same string is signed and posted", async () => {
  const fields = await checkout();

  assert.doesNotMatch(fields.Receipt, /[{}"]/, "the posted Receipt is percent-encoded");
  assert.match(fields.Receipt, /^%7B%22items%22/, "it encodes the fiscal JSON object");

  const decoded = JSON.parse(decodeURIComponent(fields.Receipt));
  assert.equal(decoded.items.length, 1);
  assert.equal(decoded.items[0].sum, Number(PILOT_AMOUNT));
  assert.equal(decoded.items[0].quantity, 1);
  assert.equal(decoded.items[0].tax, "none");
  assert.equal(decoded.items[0].payment_method, "full_prepayment");
  assert.equal(decoded.items[0].payment_object, "service");

  // The signature only reproduces if the encoded form is what was signed.
  assert.equal(fields.SignatureValue, sha256(signatureBase(fields)));
  assert.notEqual(
    fields.SignatureValue,
    sha256(signatureBase({ ...fields, Receipt: decodeURIComponent(fields.Receipt) })),
    "the raw JSON is not what this integration signs",
  );
});

// --- redirect URLs --------------------------------------------------------

test("the redirect URLs are sent as SuccessUrl2/FailUrl2 and are part of the base", async () => {
  const fields = await checkout();

  assert.equal(fields.SuccessUrl2, `${ORIGIN}/payment/success`);
  assert.equal(fields.FailUrl2, `${ORIGIN}/payment/failed`);
  assert.equal(fields.SuccessUrl2Method, "GET");
  assert.equal(fields.FailUrl2Method, "GET");

  // Robokassa's extended formula requires them once they are transmitted, so
  // a base without them must NOT reproduce the signature. If this assertion
  // ever flips, the four fields have to stop being posted in the same change.
  const withoutUrls = [
    fields.MerchantLogin,
    fields.OutSum,
    fields.InvId,
    fields.Receipt,
    PASSWORD_1,
  ].join(":");
  assert.notEqual(fields.SignatureValue, sha256(withoutUrls));

  // And signing them raw — what produced error 29 — must not reproduce it
  // either. This is the assertion that pins the fix.
  const rawUrls = [
    fields.MerchantLogin,
    fields.OutSum,
    fields.InvId,
    fields.Receipt,
    fields.SuccessUrl2,
    fields.SuccessUrl2Method,
    fields.FailUrl2,
    fields.FailUrl2Method,
    PASSWORD_1,
  ].join(":");
  assert.notEqual(fields.SignatureValue, sha256(rawUrls), "the URLs must be signed encoded");
});

test("a different redirect URL produces a different signature", async () => {
  const fields = await checkout();
  const moved = { ...fields, SuccessUrl2: "https://elsewhere.example/payment/success" };
  assert.notEqual(fields.SignatureValue, sha256(signatureBase(moved)));
});

// --- mode ------------------------------------------------------------------

test("test and live differ by IsTest and credentials, never by the formula", async () => {
  const testFields = await checkout();
  assert.equal(testFields.IsTest, "1");
  assert.equal(testFields.SignatureValue, sha256(signatureBase(testFields)));

  const previous = {
    test: process.env.ROBOKASSA_TEST_MODE,
    receipt: process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED,
    password: process.env.ROBOKASSA_PASSWORD_1,
  };
  process.env.ROBOKASSA_TEST_MODE = "false";
  process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "true";
  process.env.ROBOKASSA_PASSWORD_1 = "live-password-one";
  try {
    const liveFields = await checkout();
    assert.equal(liveFields.IsTest, "0");
    // Same base, different password: the formula did not change with the mode.
    assert.equal(liveFields.SignatureValue, sha256(signatureBase(liveFields, "live-password-one")));
    assert.notEqual(
      liveFields.SignatureValue,
      sha256(signatureBase(liveFields, PASSWORD_1)),
      "live mode must not verify against the test password",
    );
    assert.equal(liveFields.MerchantLogin, MERCHANT_LOGIN);
  } finally {
    process.env.ROBOKASSA_TEST_MODE = previous.test;
    process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = previous.receipt;
    process.env.ROBOKASSA_PASSWORD_1 = previous.password;
  }
});

// --- the inbound direction is untouched ------------------------------------

test("ResultURL still verifies OutSum:InvId:Password#2 and nothing else", async () => {
  const fields = await checkout();
  const { InvId } = fields;

  const wrong = await request(
    `/api/payment/result?OutSum=${PILOT_AMOUNT}&InvId=${InvId}` +
      `&SignatureValue=${sha256(`${PILOT_AMOUNT}:${InvId}:${PASSWORD_1}`)}`,
  );
  assert.equal(wrong.status, 403, "Password#1 must not verify a callback");
  assert.doesNotMatch(await wrong.text(), new RegExp(`OK${InvId}`));

  const right = await request(
    `/api/payment/result?OutSum=${PILOT_AMOUNT}&InvId=${InvId}` +
      `&SignatureValue=${sha256(`${PILOT_AMOUNT}:${InvId}:${PASSWORD_2}`)}`,
  );
  assert.match(await right.text(), new RegExp(`OK${InvId}`));

  const [order] = (await testDb.db.query(`SELECT status FROM orders WHERE invoice_id = ${InvId}`)).rows;
  assert.equal(order.status, "paid");
});

test("the URLs are percent-encoded in the signature and raw in the form fields", async () => {
  const fields = await checkout();

  // The transport half: the hidden inputs carry the address a human can read.
  // The browser percent-encodes them once when it submits the form, so
  // encoding them here as well would send them doubly encoded.
  assert.equal(fields.SuccessUrl2, "https://poztender.example/payment/success");
  assert.equal(fields.FailUrl2, "https://poztender.example/payment/failed");
  assert.doesNotMatch(fields.SuccessUrl2, /%3A|%2F/, "the form field must not be pre-encoded");
  assert.doesNotMatch(fields.FailUrl2, /%3A|%2F/);

  // The signature half: the base carries them encoded, matching Robokassa's
  // worked example `…:https%3A%2F%2Frobokassa.com%2F:GET:…`.
  const base = signatureBase(fields);
  assert.ok(
    base.includes("https%3A%2F%2Fpoztender.example%2Fpayment%2Fsuccess"),
    "SuccessUrl2 must be percent-encoded in the base",
  );
  assert.ok(
    base.includes("https%3A%2F%2Fpoztender.example%2Fpayment%2Ffailed"),
    "FailUrl2 must be percent-encoded in the base",
  );
  assert.ok(!base.includes("https://poztender.example"), "no raw URL survives into the base");
  assert.equal(fields.SignatureValue, sha256(base));
});
