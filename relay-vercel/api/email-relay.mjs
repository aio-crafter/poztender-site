// Transactional email for hosts that cannot reach an SMTP port.
//
// Timeweb times out on smtp.yandex.ru:465 and :587 alike, so the application
// hands the message to this endpoint over HTTPS instead and the relay does the
// SMTP conversation from Vercel.
//
// This is deliberately not a mail relay. It sends one fixed kind of message,
// from one mailbox it owns, to one recipient it validates, for one caller that
// knows a shared secret. The sender is never taken from the request: the
// envelope MAIL FROM and the From header are both built from the relay's own
// YANDEX_SMTP_USER, so a caller cannot send as anybody.
//
// The SMTP password lives only here. It is never accepted from a request and
// never logged, and neither is the recipient or any part of the message.
import { isEmailAddress, sendMail } from "../lib/smtp.mjs";

// Generous enough for the templates this project sends, small enough that the
// endpoint cannot be used to push bulk content through the mailbox.
const LIMITS = {
  to: 254,
  subject: 200,
  text: 20_000,
  html: 100_000,
};

function sendJson(response, status, body) {
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader("x-content-type-options", "nosniff");
  return response.status(status).json(body);
}

function readJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body !== "string") return {};
  try {
    return JSON.parse(request.body);
  } catch {
    return {};
  }
}

/** A string field within its limit, or null if it is anything else. */
function field(value, limit) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > limit) return null;
  return value;
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    return sendJson(response, 405, { ok: false, reason: "method-not-allowed" });
  }

  const relaySecret = process.env.EMAIL_RELAY_SECRET ?? "";
  const suppliedSecret = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (relaySecret.length < 32 || suppliedSecret !== relaySecret) {
    console.error("[email-relay] auth rejected");
    return sendJson(response, 401, { ok: false, reason: "auth-rejected" });
  }

  // Credentials come from the relay's own environment and from nowhere else.
  if (!process.env.YANDEX_SMTP_USER || !process.env.YANDEX_SMTP_PASSWORD) {
    console.error("[email-relay] YANDEX_SMTP_USER / YANDEX_SMTP_PASSWORD are not set");
    return sendJson(response, 503, { ok: false, reason: "not-configured" });
  }

  const body = readJsonBody(request);
  const to = field(body.to, LIMITS.to);
  const subject = field(body.subject, LIMITS.subject);
  const text = field(body.text, LIMITS.text);
  const html = field(body.html, LIMITS.html);

  if (to === null || subject === null || text === null || html === null) {
    console.error("[email-relay] a field was missing, not a string, or over its limit");
    return sendJson(response, 400, { ok: false, reason: "bad-request" });
  }
  if (!isEmailAddress(to)) {
    // The address itself is not logged: it identifies a customer.
    console.error("[email-relay] recipient is not a valid address");
    return sendJson(response, 400, { ok: false, reason: "invalid-recipient" });
  }
  if (!subject.trim() || (!text.trim() && !html.trim())) {
    console.error("[email-relay] empty subject or empty body");
    return sendJson(response, 400, { ok: false, reason: "bad-request" });
  }

  // `body.from` — if a caller ever sends one — is ignored here by construction:
  // sendMail takes the sender from env.YANDEX_SMTP_USER and nothing else.
  const sent = await sendMail(process.env, { to, subject, text, html });
  if (!sent) {
    // sendMail has already logged the protocol step that failed, without the
    // password and without the message.
    console.error("[email-relay] the mail server did not accept the message");
    return sendJson(response, 502, { ok: false, reason: "smtp-failed" });
  }

  return sendJson(response, 201, { ok: true });
}
