#!/usr/bin/env node
//
// Confirms a business order paid by bank transfer.
//
// Deliberately a command-line tool and not an HTTP route: settling an order is
// the one action that grants paid access, so the only thing allowed to perform
// it is something that already holds the database credentials. There is no
// endpoint an anonymous caller could reach.
//
//   DATABASE_URL='postgresql://…?sslmode=verify-full' \
//     node scripts/confirm-bank-payment.mjs <invoiceId>
//
// Individual orders are refused here — those settle through the Robokassa
// callback. Running it twice on the same order is safe: the conditional UPDATE
// matches nothing the second time, so paid_at keeps its original value and no
// second entitlement is created.
import { Pool } from "pg";

// Kept in step with ACCESS_WINDOW_SECONDS in lib/orders.ts. A mismatch would
// hand business buyers a different access window from card buyers, so the
// test suite asserts this script produces the same seven days.
const ACCESS_WINDOW_DAYS = { pilot: 7, subscription: 30 };

class OperatorError extends Error {}

async function settle(client, invoiceId) {
  await client.query("BEGIN");

  const { rows: found } = await client.query(
    `SELECT id, plan, status, buyer_type, buyer_name, buyer_inn, expected_amount, email
       FROM orders WHERE invoice_id = $1 FOR UPDATE`,
    [invoiceId],
  );
  const order = found[0];

  if (!order) throw new OperatorError(`no order with invoice id ${invoiceId}`);
  if (order.buyer_type !== "business") {
    throw new OperatorError(
      `order ${invoiceId} belongs to an individual buyer and settles through Robokassa, not by bank transfer`,
    );
  }

  const { rows: claimed } = await client.query(
    `UPDATE orders SET status = 'paid', paid_at = now()
      WHERE id = $1 AND status = 'awaiting_bank_payment'
      RETURNING paid_at`,
    [order.id],
  );

  if (claimed.length === 0) {
    await client.query("ROLLBACK");
    return [
      `order ${invoiceId} is already ${order.status}; nothing changed, no second entitlement created`,
    ];
  }

  const days = ACCESS_WINDOW_DAYS[order.plan] ?? ACCESS_WINDOW_DAYS.pilot;
  await client.query(
    `INSERT INTO access_grants (order_id, valid_from, valid_until)
     VALUES ($1, $2, $2::timestamptz + ($3 || ' days')::interval)
     ON CONFLICT (order_id) DO NOTHING`,
    [order.id, claimed[0].paid_at, String(days)],
  );

  await client.query("COMMIT");

  return [
    `order ${invoiceId} confirmed as paid`,
    `  buyer:  ${order.buyer_name} (ИНН ${order.buyer_inn})`,
    `  amount: ${order.expected_amount}`,
    `  access: ${days} days from ${claimed[0].paid_at.toISOString()}`,
    "",
    "Next: issue the НПД receipt to this buyer in «Мой налог», stating their ИНН.",
  ];
}

async function main() {
  const invoiceId = process.argv[2];
  if (!invoiceId || !/^\d{1,19}$/.test(invoiceId) || !Number.isSafeInteger(Number(invoiceId))) {
    throw new OperatorError("usage: node scripts/confirm-bank-payment.mjs <invoiceId>");
  }
  if (!process.env.DATABASE_URL) throw new OperatorError("DATABASE_URL is not set");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let client;
  try {
    client = await pool.connect();
    return await settle(client, invoiceId);
  } catch (error) {
    // Roll back before the connection goes back to the pool, so a failed run
    // never leaves an open transaction behind.
    await client?.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    // Released and closed explicitly rather than by exiting the process: an
    // abrupt exit leaves the server holding a half-open connection, which the
    // next run then cannot get past.
    client?.release();
    await pool.end().catch(() => {});
  }
}

try {
  for (const line of await main()) console.log(line);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
