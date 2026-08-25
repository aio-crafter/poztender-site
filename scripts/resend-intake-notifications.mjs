#!/usr/bin/env node
//
// Re-delivers the notifications for intake forms that are already stored.
//
// Exists because delivery must never gate acceptance: /api/intake commits the
// form to PostgreSQL first, and if Telegram or SMTP was unreachable at that
// moment the row simply carries a NULL in telegram_notified_at or
// email_notified_at. This is how those are settled afterwards.
//
//   DATABASE_URL='postgresql://…?sslmode=verify-full' \
//   TELEGRAM_BOT_TOKEN='…' TELEGRAM_OWNER_CHAT_ID='…' \
//   YANDEX_SMTP_USER='…' YANDEX_SMTP_PASSWORD='…' \
//     node scripts/resend-intake-notifications.mjs [<invoiceId>] [--force]
//
// With no invoice number it works through every form that is still missing a
// delivery. It creates no submission, spends no grant and changes no order or
// access state: the only columns it writes are the two delivery stamps.
import { Pool } from "pg";
import { findByInvoiceId, findUndelivered, redeliver } from "./lib/intake-delivery.mjs";

class OperatorError extends Error {}

function describe(row, result) {
  return `order ${row.invoice_id} (${row.company}): telegram ${result.telegram}, email ${result.email}`;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const invoiceId = args.find((arg) => arg !== "--force");

  if (invoiceId !== undefined) {
    if (!/^\d{1,19}$/.test(invoiceId) || !Number.isSafeInteger(Number(invoiceId))) {
      throw new OperatorError(
        "usage: node scripts/resend-intake-notifications.mjs [<invoiceId>] [--force]",
      );
    }
  }
  if (!process.env.DATABASE_URL) throw new OperatorError("DATABASE_URL is not set");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let client;
  try {
    client = await pool.connect();

    if (invoiceId !== undefined) {
      const row = await findByInvoiceId(client, invoiceId);
      if (!row) throw new OperatorError(`no stored intake form for order ${invoiceId}`);
      if (!force && row.telegram_notified_at && row.email_notified_at) {
        return [`order ${invoiceId} was already delivered on both channels; pass --force to re-send`];
      }
      const result = await redeliver(client, row, { force });
      return [describe(row, result)];
    }

    const rows = await findUndelivered(client);
    if (rows.length === 0) return ["every stored intake form has already been delivered"];

    const lines = [];
    for (const row of rows) {
      const result = await redeliver(client, row, { force: false });
      lines.push(describe(row, result));
    }
    return lines;
  } finally {
    client?.release();
    await pool.end().catch(() => {});
  }
}

main()
  .then((lines) => {
    for (const line of lines) console.log(line);
  })
  .catch((error) => {
    console.error(error instanceof OperatorError ? error.message : error);
    process.exitCode = 1;
  });
