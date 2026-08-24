// Minimal dependency-free SMTP transport, shared by the application and the
// administrative scripts.
//
// Written in plain JavaScript on purpose: the CLI tools under scripts/ run
// straight from source with no build step, and duplicating an SMTP client
// between them and the bundled app would be worse than this one shared file.
//
// The project cannot add npm dependencies (the Docker build runs `npm ci`
// against a pinned lockfile), so this speaks just enough SMTP over node:tls
// instead of pulling in nodemailer.
import { randomBytes } from "node:crypto";
import { connect } from "node:tls";

const SMTP_HOST = "smtp.yandex.ru";
const SMTP_PORT = 465;
const SMTP_TIMEOUT_MS = 10_000;

export function isEmailReady(env) {
  return Boolean(env.YANDEX_SMTP_USER && env.YANDEX_SMTP_PASSWORD);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function isEmailAddress(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    function onData(chunk) {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve(buffer);
      }
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function cleanup() {
      socket.off("data", onData);
      socket.off("error", onError);
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function command(socket, text, label) {
  const response = readResponse(socket);
  socket.write(`${text}\r\n`);
  const result = await response;
  const code = Number(result.slice(0, 3));
  if (code >= 400) {
    // `label` is used instead of the command itself so credentials sent during
    // AUTH never reach a log line.
    throw new Error(`SMTP ${label} failed: ${result.trim().slice(0, 120)}`);
  }
  return result;
}

const DISPLAY_NAME = "ПожТендер";

/**
 * RFC 2047 encoded-word. A header carrying raw UTF-8 is one of the defects
 * behind Yandex's "554 Message rejected under suspicion of SPAM", so every
 * non-ASCII header value goes through this.
 */
function encodeWord(text) {
  return `=?UTF-8?B?${Buffer.from(text, "utf-8").toString("base64")}?=`;
}

/**
 * RFC 2045 caps a base64 body line at 76 characters and RFC 5321 refuses any
 * line over 1000 octets; the access template encodes to ~1300 on one line.
 */
function base64Body(text) {
  const encoded = Buffer.from(text ?? "", "utf-8").toString("base64");
  return encoded.length === 0 ? "" : encoded.match(/.{1,76}/g).join("\r\n");
}

/** Unique per message, in the sending mailbox's own domain. */
function messageId(from) {
  const domain = from.split("@")[1] || "poztender.ru";
  return `<${Date.now()}.${randomBytes(8).toString("hex")}@${domain}>`;
}

/**
 * Last-resort plain-text rendering, used only if a caller supplies none. An
 * empty text/plain part would be worse than a rough one.
 */
function textFromHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Builds one multipart/alternative message: text/plain first, text/html
 * second, both base64 with wrapped lines. Exported so tests can assert the
 * wire format without opening a socket.
 */
export function buildMessage(from, to, subject, { html, text } = {}) {
  const boundary = `bnd_${randomBytes(12).toString("hex")}`;
  const plain = text && String(text).trim() ? text : textFromHtml(html);
  return [
    `From: ${encodeWord(DISPLAY_NAME)} <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId(from)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(plain),
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(html),
    "",
    `--${boundary}--`,
  ].join("\r\n");
}

/**
 * Sends one message. Resolves to true on success and false on any failure —
 * callers decide what a failure means, and none of them may treat it as a
 * reason to undo money that has already arrived.
 *
 * Nothing here logs the password, the recipient's message body or the token
 * that may be inside it.
 */
export async function sendMail(env, { to, subject, html, text }) {
  if (!isEmailReady(env)) return false;
  if (!isEmailAddress(to)) return false;

  const user = env.YANDEX_SMTP_USER;
  const password = env.YANDEX_SMTP_PASSWORD;

  const task = new Promise((resolve) => {
    let settled = false;
    function finish(result, error) {
      if (settled) return;
      settled = true;
      if (error) console.error("[email] send failed:", error instanceof Error ? error.message : error);
      resolve(result);
    }

    let socket;
    try {
      socket = connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
    } catch (error) {
      finish(false, error);
      return;
    }
    socket.on("error", (error) => finish(false, error));

    (async () => {
      try {
        await readResponse(socket);
        await command(socket, "EHLO poztender.ru", "EHLO");
        await command(socket, "AUTH LOGIN", "AUTH");
        await command(socket, Buffer.from(user, "utf-8").toString("base64"), "AUTH user");
        await command(socket, Buffer.from(password, "utf-8").toString("base64"), "AUTH password");
        await command(socket, `MAIL FROM:<${user}>`, "MAIL FROM");
        await command(socket, `RCPT TO:<${to}>`, "RCPT TO");
        await command(socket, "DATA", "DATA");
        await command(socket, `${buildMessage(user, to, subject, { html, text })}\r\n.`, "message body");
        await command(socket, "QUIT", "QUIT");
        socket.end();
        finish(true);
      } catch (error) {
        try {
          socket.destroy();
        } catch {
          // already closed
        }
        finish(false, error);
      }
    })();
  });

  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), SMTP_TIMEOUT_MS));
  return Promise.race([task, timeout]);
}
