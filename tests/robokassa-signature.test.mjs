// The outbound Robokassa payment signature.
//
// Live checkout reported error 29 — "invalid SignatureValue" — and until now
// nothing pinned the base string: the suite only asserted that a signature was
// produced. These tests recompute it independently from the fields the form
// actually POSTs, so the base and the payload can never drift apart again, and
// so any future change to the formula has to be a deliberate one.
//
// The contract asserted here:
//
//   MerchantLogin:OutSum:InvId:Receipt:Password#1
//
// A live bisect against auth.robokassa.ru settled which shape the account
// accepts. A minimal signed request was accepted; the same request with a raw
// JSON receipt was refused with error 29; with the receipt percent-encoded it
// was accepted again; and adding SuccessUrl2/FailUrl2 refused it once more, in
// every encoding tried. A deliberately corrupted signature was refused too, so
// the classifier that produced those verdicts was itself verified.
//
// So: the receipt is percent-encoded and signed, and the redirect addresses
// come from the merchant account rather than from the request. The four
// SuccessUrl2/FailUrl2 fields must not come back.
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
 * The base, rebuilt here from the fields the form really sends. The receipt is
 * already percent-encoded when it reaches the form, so it is taken as-is.
 */
function signatureBase(fields, password = PASSWORD_1) {
  return [
    fields.MerchantLogin,
    fields.OutSum,
    fields.InvId,
    fields.Receipt,
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

// --- redirect URLs are the account's business, not the request's ----------

test("the four SuccessUrl2/FailUrl2 fields are no longer posted", async () => {
  const fields = await checkout();

  for (const name of ["SuccessUrl2", "SuccessUrl2Method", "FailUrl2", "FailUrl2Method"]) {
    assert.equal(fields[name], undefined, `${name} must not be sent`);
  }
});

test("no redirect address appears anywhere in the checkout form", async () => {
  const response = await request("/api/payment/start?email=buyer%40example.ru");
  const html = await response.text();

  // Not as a field, not as a stray value: the browser is handed nothing that
  // names where the customer comes back to.
  assert.doesNotMatch(html, /payment\/success/, "the success address is delegated");
  assert.doesNotMatch(html, /payment\/failed/, "the fail address is delegated");
  assert.doesNotMatch(html, /Url2/i);
});

test("no redirect value can reproduce the signature", async () => {
  const fields = await checkout();
  const successUrl = `${ORIGIN}/payment/success`;
  const failUrl = `${ORIGIN}/payment/failed`;

  // Both shapes that were tried against the live endpoint and refused with
  // error 29: the URLs percent-encoded in the base, and the URLs raw. Neither
  // may come back.
  const encoded = [
    fields.MerchantLogin, fields.OutSum, fields.InvId, fields.Receipt,
    encodeURIComponent(successUrl), "GET", encodeURIComponent(failUrl), "GET", PASSWORD_1,
  ].join(":");
  const raw = [
    fields.MerchantLogin, fields.OutSum, fields.InvId, fields.Receipt,
    successUrl, "GET", failUrl, "GET", PASSWORD_1,
  ].join(":");

  assert.notEqual(fields.SignatureValue, sha256(encoded), "encoded URLs are not in the base");
  assert.notEqual(fields.SignatureValue, sha256(raw), "raw URLs are not in the base");
  assert.equal(fields.SignatureValue, sha256(signatureBase(fields)));
});

test("the signed base is exactly MerchantLogin:OutSum:InvId:Receipt:Password#1", async () => {
  const fields = await checkout();
  const literal = `${fields.MerchantLogin}:${fields.OutSum}:${fields.InvId}:${fields.Receipt}:${PASSWORD_1}`;

  assert.equal(fields.SignatureValue, sha256(literal));
  assert.equal(literal.split(":").length, 5, "five colon-separated parts, nothing more");
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

test("the posted field set is exactly the nine fields the account expects", async () => {
  const fields = await checkout();

  assert.deepEqual(
    Object.keys(fields).sort(),
    [
      "Culture",
      "Description",
      "Email",
      "InvId",
      "IsTest",
      "MerchantLogin",
      "OutSum",
      "Receipt",
      "SignatureValue",
    ],
    "adding a field here means deciding whether it belongs in the signature too",
  );
});
