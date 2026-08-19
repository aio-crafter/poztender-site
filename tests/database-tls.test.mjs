// TLS is configured in DATABASE_URL and nowhere else, so a remote database
// reached without strict verification must not be usable at all.
//
// Its own file because the pool is created once per process: the guard runs on
// first use, and a fresh process is the only way to exercise a different
// DATABASE_URL.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before } from "node:test";

const ORIGIN = "https://poztender.example";
const PASSWORD_2 = "fake-password-two";
const PILOT_AMOUNT = "4900.00";
const INVOICE_ID = "4503599627370494";

let worker;

before(async () => {
  // A remote host with no sslmode at all: payment records would travel over an
  // unverified connection, so the guard must refuse it.
  process.env.DATABASE_URL = "postgresql://user:pass@db.example.invalid/poztender";
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

test("a remote database without sslmode=verify-full cannot start a checkout", async () => {
  const response = await request("/api/payment/start?email=buyer%40example.ru");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${ORIGIN}/payment?error=store`);
});

test("a remote database without sslmode=verify-full never acknowledges a callback", async () => {
  const response = await request(
    `/api/payment/result?OutSum=${PILOT_AMOUNT}&InvId=${INVOICE_ID}` +
      `&SignatureValue=${resultSignature(PILOT_AMOUNT, INVOICE_ID)}`,
  );
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /^OK/);
});

test("verify-full stays strict even under libpq compatibility", async () => {
  // The reason verify-full is the only accepted mode: it is the one value that
  // means the same thing in both of pg-connection-string's branches.
  const { default: ConnectionParameters } = await import("pg/lib/connection-parameters.js");
  const ssl = (query) =>
    new ConnectionParameters({
      connectionString: `postgresql://u:p@host.neon.tech/db?${query}`,
    }).ssl;

  assert.deepEqual(ssl("sslmode=verify-full"), {});
  assert.deepEqual(ssl("uselibpqcompat=true&sslmode=verify-full"), {});
  // …whereas require flips to an unverified connection under libpq semantics,
  // which is why the guard refuses that combination outright.
  assert.deepEqual(ssl("uselibpqcompat=true&sslmode=require"), { rejectUnauthorized: false });
});

test("the guard refuses insecure modes and accepts only verify-full", async () => {
  // Exercised directly against the connection-string parser that ships with
  // pg, so the expectations track the real driver rather than a description of
  // it. `{}` means Node's TLS defaults apply: chain and hostname are verified.
  const { default: ConnectionParameters } = await import("pg/lib/connection-parameters.js");
  const sslFor = (mode) =>
    new ConnectionParameters({
      connectionString: `postgresql://u:p@host.neon.tech/db?sslmode=${mode}`,
      // Deliberately passed and deliberately ignored: any sslmode in the URL
      // replaces this object outright, which is why the application no longer
      // sets one.
      ssl: { rejectUnauthorized: false },
    }).ssl;

  assert.deepEqual(sslFor("verify-full"), {}, "verify-full must verify chain and hostname");
  assert.deepEqual(sslFor("require"), {}, "pg 8 still treats require as verify-full");
  assert.equal(sslFor("disable"), false);
  assert.deepEqual(sslFor("no-verify"), { rejectUnauthorized: false });

  // And with no ssl parameters in the URL the object is *not* ignored — which
  // is exactly the ambiguity the single-source rule removes.
  const withoutMode = new ConnectionParameters({
    connectionString: "postgresql://u:p@host.neon.tech/db",
    ssl: { rejectUnauthorized: false },
  }).ssl;
  assert.deepEqual(withoutMode, { rejectUnauthorized: false });
});
