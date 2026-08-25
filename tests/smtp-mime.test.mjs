// The wire format of the transactional emails.
//
// Yandex rejected the access email with "554 5.7.1 Message rejected under
// suspicion of SPAM". scripts/test-smtp.mjs bisected it: a minimal plain-text
// message, the payment subject, the site domain, an internal URL and a
// recovery URL were all accepted; the HTML-only production shape was rejected,
// and so was the same shape with its base64 body wrapped — while the same
// content sent as correct MIME was accepted. These tests pin that corrected
// shape so the defects cannot come back.
//
// Nothing here opens a socket: buildMessage is pure.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { accessEmailHtml, accessEmailSubject, accessEmailText } from "../lib/access-email.mjs";
import { intakeEmailHtml, intakeEmailSubject, intakeEmailText } from "../lib/intake-email.mjs";
import { buildMessage } from "../lib/smtp.mjs";

const FROM = "info@poztender.ru";
const TO = "buyer@example.com";
// Token-shaped and inert: it is not a credential and grants nothing.
const RECOVERY_URL = "https://poztender.ru/api/access?token=FAKE-TOKEN-NOT-A-CREDENTIAL";

function accessContent(plan = "pilot") {
  return {
    invoiceId: "412040522831714",
    amount: "4900.00",
    plan,
    accessUntil: new Date("2026-09-01T12:00:00Z"),
    url: RECOVERY_URL,
  };
}

function accessMessage(plan = "pilot") {
  const content = accessContent(plan);
  return buildMessage(FROM, TO, accessEmailSubject(content.invoiceId), {
    html: accessEmailHtml(content),
    text: accessEmailText(content),
  });
}

const headersOf = (message) => message.split("\r\n\r\n")[0];

/** Splits a multipart/alternative message and decodes each base64 body. */
function partsOf(message) {
  const boundary = /boundary="([^"]+)"/.exec(headersOf(message))[1];
  return message
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [head, body] = part.replace(/^\r\n/, "").split("\r\n\r\n");
      return {
        head,
        body: Buffer.from(body.trim().split("\r\n").join(""), "base64").toString("utf-8"),
      };
    });
}

test("no header carries raw non-ASCII bytes", () => {
  const message = accessMessage();
  // Equal only when every code unit is below 0x80: any non-ASCII character
  // would take more than one UTF-8 byte.
  assert.equal(
    Buffer.byteLength(message, "utf-8"),
    message.length,
    "the encoded message must be pure ASCII on the wire",
  );
  assert.match(
    headersOf(message),
    /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <info@poztender\.ru>$/m,
    "the display name must be an RFC 2047 encoded-word",
  );
  assert.match(headersOf(message), /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
});

test("the From header stays the authenticated mailbox", () => {
  assert.match(headersOf(accessMessage()), /^From: [^<]+ <info@poztender\.ru>$/m);
});

test("Message-ID, Date and MIME-Version are present, and the Message-ID is unique", () => {
  const headers = headersOf(accessMessage());
  assert.match(headers, /^Message-ID: <\d+\.[0-9a-f]{16}@poztender\.ru>$/m);
  assert.match(headers, /^Date: \w{3}, \d{1,2} \w{3} \d{4} /m);
  assert.match(headers, /^MIME-Version: 1\.0$/m);

  const first = /^Message-ID: (.+)$/m.exec(headers)[1];
  const second = /^Message-ID: (.+)$/m.exec(headersOf(accessMessage()))[1];
  assert.notEqual(first, second);
});

test("the body is multipart/alternative with a text/plain and a text/html part", () => {
  const message = accessMessage();
  assert.match(headersOf(message), /^Content-Type: multipart\/alternative; boundary="[^"]+"$/m);

  const parts = partsOf(message);
  assert.equal(parts.length, 2);
  assert.match(parts[0].head, /^Content-Type: text\/plain; charset="UTF-8"$/m);
  assert.match(parts[0].head, /^Content-Transfer-Encoding: base64$/m);
  assert.match(parts[1].head, /^Content-Type: text\/html; charset="UTF-8"$/m);
  assert.match(parts[1].head, /^Content-Transfer-Encoding: base64$/m);
  assert.ok(message.endsWith("--"), "the message must close with the terminating boundary");
});

test("the recovery URL reaches the customer in both representations", () => {
  const [plain, html] = partsOf(accessMessage());
  assert.ok(plain.body.includes(RECOVERY_URL), "plain text must carry the bare URL");
  assert.ok(html.body.includes(`href="${RECOVERY_URL}"`), "HTML must carry the link");
});

test("the plain-text part carries the whole confirmation", () => {
  const [plain] = partsOf(accessMessage());
  assert.match(plain.body, /Оплата получена\./);
  assert.match(plain.body, /Заказ №412040522831714/);
  assert.match(plain.body, /4900\.00 ₽/);
  assert.match(plain.body, /Доступ активен до \d{1,2} \S+ \d{4}/);
  assert.match(plain.body, /Перейти к анкете: https:\/\//);

  const [subscription] = partsOf(accessMessage("subscription"));
  assert.match(subscription.body, /Открыть подтверждение: https:\/\//);
  assert.match(subscription.body, /Обслуживание продлено/);
});

test("no line exceeds the SMTP line-length limit", () => {
  for (const line of accessMessage().split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf-8") <= 998, `line too long: ${line.length} octets`);
  }
});

test("a caller that supplies no plain text still gets a non-empty text/plain part", () => {
  const message = buildMessage(FROM, TO, "Тест", { html: "<p>Оплата получена.</p>" });
  const [plain, html] = partsOf(message);
  assert.match(plain.head, /text\/plain/);
  assert.match(plain.body, /Оплата получена\./);
  assert.match(html.body, /<p>/);
});

test("the transport never logs credentials, tokens or message contents", async () => {
  const source = await readFile(new URL("../lib/smtp.mjs", import.meta.url), "utf-8");

  const calls = source.match(/console\.[a-z]+\([^\n]*/g) ?? [];
  assert.ok(calls.length > 0, "the guard must actually inspect something");
  for (const call of calls) {
    assert.doesNotMatch(call, /password|token|\bhtml\b|\btext\b|\buser\b|\bto\b/i, call);
  }
  assert.doesNotMatch(source, /console\.log/);
  // Failures report the protocol step, never the line that was sent, so an
  // AUTH payload can never surface in an error message.
  assert.match(source, /throw new Error\(`SMTP \$\{label\} failed/);
});

// --- the intake confirmation ----------------------------------------------
//
// The brief form lets the customer choose where the answer should come back,
// Telegram or email. That choice used to reach the owner's notification only:
// the confirmation said "ответим выбранным способом связи" without naming it,
// and a customer who picked Telegram got their only acknowledgement by email.
// The wording now names the chosen channel. It is text only — a bot cannot
// open a chat from a @username, so nothing here messages the customer.

function intakeContent(overrides = {}) {
  return {
    contactName: "Иван Петров",
    company: "ООО «Ромашка»",
    replyChannel: "email",
    telegram: "",
    ...overrides,
  };
}

function intakeParts(overrides = {}) {
  const content = intakeContent(overrides);
  return partsOf(
    buildMessage(FROM, TO, intakeEmailSubject(), {
      html: intakeEmailHtml(content),
      text: intakeEmailText(content),
    }),
  );
}

test("choosing email makes the confirmation name this email", () => {
  const [plain, html] = intakeParts({ replyChannel: "email" });

  for (const body of [plain.body, html.body]) {
    assert.match(body, /Ответим на этот email\./);
    assert.doesNotMatch(body, /Ответим в Telegram:/);
  }
});

test("choosing Telegram makes the confirmation name the Telegram contact", () => {
  const [plain, html] = intakeParts({ replyChannel: "telegram", telegram: "@petrov_fire" });

  for (const body of [plain.body, html.body]) {
    assert.match(body, /Ответим в Telegram: @petrov_fire/);
    assert.doesNotMatch(body, /Ответим на этот email\./);
  }
});

test("a Telegram contact given as a phone number is carried verbatim", () => {
  const [plain, html] = intakeParts({
    replyChannel: "telegram",
    telegram: "+7 999 123-45-67",
  });

  for (const body of [plain.body, html.body]) {
    assert.match(body, /Ответим в Telegram: \+7 999 123-45-67/);
  }
});

test("a Telegram choice with no contact falls back to the email wording", () => {
  const [plain, html] = intakeParts({ replyChannel: "telegram", telegram: "" });

  for (const body of [plain.body, html.body]) {
    assert.match(body, /Ответим на этот email\./);
    assert.doesNotMatch(body, /Ответим в Telegram:/);
  }
});

test("both representations of the confirmation agree on the channel sentence", () => {
  for (const overrides of [
    { replyChannel: "email" },
    { replyChannel: "telegram", telegram: "@petrov_fire" },
  ]) {
    const [plain, html] = intakeParts(overrides);
    const sentence = /(Ответим (?:на этот email\.|в Telegram: \S+))/;
    assert.equal(sentence.exec(plain.body)[1], sentence.exec(html.body)[1]);
  }
});

test("the confirmation still carries the received-your-form facts", () => {
  const [plain, html] = intakeParts();

  for (const body of [plain.body, html.body]) {
    assert.match(body, /Здравствуйте, Иван Петров!/);
    assert.match(body, /Мы получили анкету/);
    assert.match(body, /ООО «Ромашка»/);
    assert.match(body, /в течение рабочего дня/);
    assert.match(body, /@kruger79/);
  }
});

test("customer-supplied values are escaped in the HTML part", () => {
  const [, html] = intakeParts({
    contactName: "<script>alert(1)</script>",
    company: "A & B",
    replyChannel: "telegram",
    telegram: "@a<b>",
  });

  assert.doesNotMatch(html.body, /<script>/);
  assert.match(html.body, /&lt;script&gt;/);
  assert.match(html.body, /A &amp; B/);
  assert.match(html.body, /@a&lt;b&gt;/);
});

test("the confirmation is sent as correct MIME, exactly like the access email", () => {
  const content = intakeContent({ replyChannel: "telegram", telegram: "@petrov_fire" });
  const message = buildMessage(FROM, TO, intakeEmailSubject(), {
    html: intakeEmailHtml(content),
    text: intakeEmailText(content),
  });

  assert.equal(
    Buffer.byteLength(message, "utf-8"),
    message.length,
    "the encoded message must be pure ASCII on the wire",
  );
  const headers = headersOf(message);
  assert.match(headers, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <info@poztender\.ru>$/m);
  assert.match(headers, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  assert.match(headers, /^Message-ID: <\d+\.[0-9a-f]{16}@poztender\.ru>$/m);
  assert.match(headers, /^Date: \w{3}, \d{1,2} \w{3} \d{4} /m);
  assert.match(headers, /^MIME-Version: 1\.0$/m);
  assert.match(headers, /^Content-Type: multipart\/alternative; boundary="[^"]+"$/m);

  const parts = partsOf(message);
  assert.equal(parts.length, 2);
  assert.match(parts[0].head, /^Content-Type: text\/plain; charset="UTF-8"$/m);
  assert.match(parts[1].head, /^Content-Type: text\/html; charset="UTF-8"$/m);
  for (const line of message.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf-8") <= 998, `line too long: ${line.length} octets`);
  }
});
