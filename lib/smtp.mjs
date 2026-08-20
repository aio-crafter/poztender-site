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

function buildMessage(from, to, subject, html) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
  return [
    `From: ПожТендер <${from}>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf-8").toString("base64"),
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
export async function sendMail(env, { to, subject, html }) {
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
        await command(socket, `${buildMessage(user, to, subject, html)}\r\n.`, "message body");
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
