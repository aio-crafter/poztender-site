#!/usr/bin/env node
//
// Re-sends the access email for an order that is already paid.
//
// Exists because delivery must never gate money: if SMTP was down when the
// payment was confirmed, the order stays paid and access stays open, and this
// is how the customer is told about it afterwards.
//
//   PUBLIC_ORIGIN='https://poztender.ru' \
//   DATABASE_URL='postgresql://…?sslmode=verify-full' \
//     node scripts/resend-access.mjs <invoiceId>
//
// It creates no grant, extends nothing and changes no order state. It mints a
// fresh token for the existing link row — the previous link stops working,
// which is the point of a re-send. Deliberately a CLI, not an HTTP endpoint:
// anything that emails an access link must hold the database credentials.
import { Pool } from "pg";
import { deliverAccessEmail, requireOrigin } from "./lib/access-delivery.mjs";

class OperatorError extends Error {}

async function main() {
  const invoiceId = process.argv[2];
  if (!invoiceId || !/^\d{1,19}$/.test(invoiceId) || !Number.isSafeInteger(Number(invoiceId))) {
    throw new OperatorError("usage: node scripts/resend-access.mjs <invoiceId>");
  }
  if (!process.env.DATABASE_URL) throw new OperatorError("DATABASE_URL is not set");
  const origin = requireOrigin();

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let client;
  try {
    client = await pool.connect();
    const { rows } = await client.query(
      `SELECT id, invoice_id, plan, status, email, expected_amount FROM orders WHERE invoice_id = $1`,
      [invoiceId],
    );
    const order = rows[0];
    if (!order) throw new OperatorError(`no order with invoice id ${invoiceId}`);
    if (order.status !== "paid") {
      throw new OperatorError(`order ${invoiceId} is ${order.status}, not paid — nothing to send`);
    }

    const outcome = await deliverAccessEmail(client, order, origin);
    if (outcome === "sent") {
      return [`access email re-sent for order ${invoiceId} to ${order.email}`];
    }
    if (outcome === "no-link") {
      throw new OperatorError(
        `order ${invoiceId} has no active access period — the grant is missing, revoked or expired`,
      );
    }
    if (outcome === "not-configured") {
      throw new OperatorError("YANDEX_SMTP_USER / YANDEX_SMTP_PASSWORD are not set");
    }
    throw new OperatorError("the mail server rejected the message; see the error above");
  } finally {
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
