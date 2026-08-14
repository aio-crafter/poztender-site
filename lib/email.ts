import { connect, type TLSSocket } from "node:tls";

export interface EmailEnvironment {
  YANDEX_SMTP_USER?: string;
  YANDEX_SMTP_PASSWORD?: string;
}

interface ConfirmationInput {
  to: string;
  company: string;
  contactName: string;
}

const SMTP_HOST = "smtp.yandex.ru";
const SMTP_PORT = 465;
const SMTP_TIMEOUT_MS = 10_000;

export function isEmailReady(env: EmailEnvironment) {
  return Boolean(env.YANDEX_SMTP_USER && env.YANDEX_SMTP_PASSWORD);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildMessage(from: string, to: string, contactName: string, company: string) {
  const subject = "Анкета получена — ПожТендер";
  const safeName = escapeHtml(contactName || "коллеги");
  const safeCompany = escapeHtml(company || "вашей компании");
  const html = "<!doctype html><html><body style=\"font-family:Arial,sans-serif;color:#11130f;\">"
    + `<p>Здравствуйте, ${safeName}!</p>`
    + `<p>Мы получили анкету для настройки тендерного радара АПС и СОУЭ для ${safeCompany}.</p>`
    + "<p>Ответим выбранным способом связи в течение рабочего дня. Если появятся вопросы раньше — пишите в Telegram "
    + "<a href=\"https://t.me/kruger79\">@kruger79</a> или на этот email.</p>"
    + "<p>— Команда ПожТендер</p>"
    + "</body></html>";
  const date = new Date().toUTCString();
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
  const lines = [
    `From: ПожТендер <${from}>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `Date: ${date}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=\"UTF-8\"",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf-8").toString("base64"),
  ];
  return lines.join("\r\n");
}

function readResponse(socket: TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    function onData(chunk: Buffer) {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve(buffer);
      }
    }
    function onError(error: Error) {
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

async function command(socket: TLSSocket, text: string) {
  const response = readResponse(socket);
  socket.write(`${text}\r\n`);
  const result = await response;
  const code = Number(result.slice(0, 3));
  if (code >= 400) {
    throw new Error(`SMTP command failed: ${text.slice(0, 40)} -> ${result.trim()}`);
  }
  return result;
}

// Minimal dependency-free SMTP client for a single best-effort confirmation
// email. This project cannot add npm dependencies (Docker build runs
// `npm ci`, which requires an exact package-lock.json match that we cannot
// regenerate here), so we speak just enough SMTP over node:tls instead of
// pulling in nodemailer. Any failure is swallowed and reported as `false` —
// a broken mailbox must never block or fail the paid intake submission.
export async function sendIntakeConfirmationEmail(
  env: EmailEnvironment,
  input: ConfirmationInput,
): Promise<boolean> {
  if (!isEmailReady(env)) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) return false;

  const user = env.YANDEX_SMTP_USER!;
  const password = env.YANDEX_SMTP_PASSWORD!;

  const task = new Promise<boolean>((resolve) => {
    let settled = false;
    function finish(result: boolean, error?: unknown) {
      if (settled) return;
      settled = true;
      if (error) console.error("[email] confirmation send failed", error);
      resolve(result);
    }

    let socket: TLSSocket;
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
        await command(socket, "EHLO poztender.ru");
        await command(socket, "AUTH LOGIN");
        await command(socket, Buffer.from(user, "utf-8").toString("base64"));
        await command(socket, Buffer.from(password, "utf-8").toString("base64"));
        await command(socket, `MAIL FROM:<${user}>`);
        await command(socket, `RCPT TO:<${input.to}>`);
        await command(socket, "DATA");
        const message = buildMessage(user, input.to, input.contactName, input.company);
        await command(socket, `${message}\r\n.`);
        await command(socket, "QUIT");
        socket.end();
        finish(true);
      } catch (error) {
        try {
          socket.destroy();
        } catch {
          // socket already closed — ignore
        }
        finish(false, error);
      }
    })();
  });

  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), SMTP_TIMEOUT_MS);
  });

  return Promise.race([task, timeout]);
}
