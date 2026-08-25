// Re-delivery of intake notifications for the administrative scripts.
//
// The scripts run straight from source with no build step, so they cannot
// import the TypeScript layer the app uses. The SQL here mirrors
// lib/intake-submissions.ts, and the notification builder, the email template
// and both transports are the same modules the app uses, so a re-sent
// notification is identical to the original.
//
// Nothing here creates a submission, spends a grant or touches an order: it
// only reads stored forms and stamps the delivery columns.
import { intakeEmailHtml, intakeEmailSubject, intakeEmailText } from "../../lib/intake-email.mjs";
import { createIntakeNotification } from "../../lib/intake-notification.mjs";
import { isEmailReady, sendMail } from "../../lib/smtp.mjs";
import { sendOwnerMessage } from "../../lib/telegram.mjs";

const COLUMNS = `
  s.id, s.order_id, s.company, s.inn, s.contact_name, s.email, s.telegram,
  s.reply_channel, s.regions, s.work_types, s.budget, s.licenses, s.exclusions,
  s.submitted_at, s.telegram_notified_at, s.email_notified_at,
  o.invoice_id, o.buyer_type, o.buyer_inn, o.buyer_name
`;

/** Every stored form still missing at least one delivery, oldest first. */
export async function findUndelivered(client) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS}
       FROM intake_submissions s
       JOIN orders o ON o.id = s.order_id
      WHERE s.telegram_notified_at IS NULL OR s.email_notified_at IS NULL
      ORDER BY s.submitted_at ASC`,
  );
  return rows;
}

/** One stored form, addressed by the invoice number the customer knows. */
export async function findByInvoiceId(client, invoiceId) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS}
       FROM intake_submissions s
       JOIN orders o ON o.id = s.order_id
      WHERE o.invoice_id = $1`,
    [invoiceId],
  );
  return rows[0] ?? null;
}

/** The shape lib/intake-notification.mjs and lib/intake-email.mjs expect. */
function submissionData(row) {
  return {
    company: row.company,
    inn: row.inn,
    contactName: row.contact_name,
    email: row.email,
    telegram: row.telegram,
    replyChannel: row.reply_channel,
    regions: row.regions,
    workTypes: row.work_types,
    budget: row.budget,
    licenses: row.licenses,
    exclusions: row.exclusions,
  };
}

/**
 * Re-sends whatever is still missing for one stored form and stamps what
 * succeeded. `force` re-sends a channel that is already stamped, for the case
 * where a message was delivered to the wrong place.
 *
 * Returns what happened per channel: "sent", "already", "failed" or
 * "not-configured".
 */
export async function redeliver(client, row, { force = false } = {}) {
  const data = submissionData(row);
  const result = { telegram: "already", email: "already" };

  if (force || !row.telegram_notified_at) {
    const notification = createIntakeNotification(data, String(row.invoice_id), {
      buyerType: row.buyer_type,
      buyerInn: row.buyer_inn,
      buyerName: row.buyer_name,
    });
    const delivery = await sendOwnerMessage(process.env, notification, "[resend-intake]");
    result.telegram = delivery.ok ? "sent" : "failed";
    if (delivery.ok) {
      await client.query(
        `UPDATE intake_submissions SET telegram_notified_at = now() WHERE id = $1`,
        [row.id],
      );
    }
  }

  if (force || !row.email_notified_at) {
    if (!isEmailReady(process.env)) {
      result.email = "not-configured";
    } else {
      const sent = await sendMail(process.env, {
        to: row.email,
        subject: intakeEmailSubject(),
        html: intakeEmailHtml(data),
        text: intakeEmailText(data),
      });
      result.email = sent ? "sent" : "failed";
      if (sent) {
        await client.query(
          `UPDATE intake_submissions SET email_notified_at = now() WHERE id = $1`,
          [row.id],
        );
      }
    }
  }

  return result;
}
