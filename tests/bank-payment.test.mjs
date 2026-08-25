// The administrative tool that settles a business order paid by bank transfer.
//
// Its own file with its own database: PGlite serves one connection at a time,
// and the application's pool in tests/payment.test.mjs holds that connection
// open, so the tool could never get in there. Here nothing else is connected
// and the real script runs as a real child process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { startTestDatabase } from "./helpers/postgres.mjs";

const DB_PORT = 55_700 + (process.pid % 200);
const SCRIPT = fileURLToPath(new URL("../scripts/confirm-bank-payment.mjs", import.meta.url));
const ORG_INN = "7707083893";

let testDb;

before(async () => {
  testDb = await startTestDatabase(DB_PORT);
});

after(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.reset();
});

function runScript(invoiceId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...(invoiceId === undefined ? [] : [String(invoiceId)])], {
      env: { ...process.env, DATABASE_URL: testDb.url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const rows = async (sql) => (await testDb.db.query(sql)).rows;

async function seedOrder({ invoiceId, buyerType = "business", status = "awaiting_bank_payment", plan = "pilot" }) {
  const requisites = buyerType === "business" ? `'${ORG_INN}', 'ООО «Ромашка»'` : "NULL, NULL";
  await testDb.db.query(
    `INSERT INTO orders (invoice_id, plan, expected_amount, email, status, session_hash, buyer_type, buyer_inn, buyer_name)
     VALUES (${invoiceId}, '${plan}', 4900.00, 'buyer@company.ru', '${status}', 'hash-${invoiceId}', '${buyerType}', ${requisites})`,
  );
}

test("confirms a business order and creates exactly one entitlement", async () => {
  await seedOrder({ invoiceId: 1001 });

  const result = await runScript(1001);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /confirmed as paid/);
  assert.match(result.stdout, new RegExp(ORG_INN));
  // The operator is reminded of the one step the software cannot do.
  assert.match(result.stdout, /Мой налог/);

  const [order] = await rows("SELECT * FROM orders");
  assert.equal(order.status, "paid");
  assert.ok(order.paid_at);

  const grants = await rows("SELECT * FROM access_grants");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].order_id, order.id);
  assert.equal(
    new Date(grants[0].valid_from).getTime(),
    new Date(order.paid_at).getTime(),
    "access runs from the confirmed payment",
  );
  // The same window a card buyer gets, so the two rails stay in step.
  const days = (new Date(grants[0].valid_until) - new Date(grants[0].valid_from)) / 86_400_000;
  assert.equal(Math.round(days), 7);
});

test("a subscription order gets the thirty-day window", async () => {
  await seedOrder({ invoiceId: 1002, plan: "subscription" });
  assert.equal((await runScript(1002)).code, 0);

  const [grant] = await rows("SELECT * FROM access_grants");
  const days = (new Date(grant.valid_until) - new Date(grant.valid_from)) / 86_400_000;
  assert.equal(Math.round(days), 30);
});

test("running it twice changes nothing and creates no second entitlement", async () => {
  await seedOrder({ invoiceId: 1003 });
  assert.equal((await runScript(1003)).code, 0);

  const [before] = await rows("SELECT * FROM orders");
  const [firstGrant] = await rows("SELECT * FROM access_grants");

  const again = await runScript(1003);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already paid|nothing changed/i);

  const [after] = await rows("SELECT * FROM orders");
  const grants = await rows("SELECT * FROM access_grants");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].id, firstGrant.id);
  assert.equal(
    new Date(after.paid_at).getTime(),
    new Date(before.paid_at).getTime(),
    "paid_at must not move",
  );
});

test("it refuses an individual order, which settles through Robokassa", async () => {
  await seedOrder({ invoiceId: 1004, buyerType: "individual", status: "pending" });

  const result = await runScript(1004);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /individual buyer/i);

  const [order] = await rows("SELECT * FROM orders");
  assert.equal(order.status, "pending", "the card rail must be left alone");
  assert.equal((await rows("SELECT * FROM access_grants")).length, 0);
});

test("it refuses an unknown invoice and a malformed argument", async () => {
  const unknown = await runScript(999_999_999);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /no order/i);

  for (const bad of ["abc", "-1", "1.5", ""]) {
    const result = await runScript(bad);
    assert.notEqual(result.code, 0, bad);
    assert.match(result.stderr, /usage/i, bad);
  }

  const missing = await runScript(undefined);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /usage/i);
});

test("it refuses to run without a database", async () => {
  const child = spawn(process.execPath, [SCRIPT, "1005"], {
    env: { ...process.env, DATABASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.notEqual(code, 0);
  assert.match(stderr, /DATABASE_URL is not set/);
});
