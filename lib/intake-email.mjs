// The "we received your intake form" confirmation sent to the customer.
//
// Lives in its own module, like access-email.mjs, so the wording is testable
// without going through the SMTP transport or the built server bundle.
import { escapeHtml } from "./smtp.mjs";

export function intakeEmailSubject() {
  return "Анкета получена — ПожТендер";
}

/**
 * The wording both representations share, so the plain-text alternative can
 * never drift away from what the HTML part says.
 *
 * `reply` names the channel the customer picked in the form. It is text only:
 * the answer itself is written by a person, and nothing here sends the
 * customer a Telegram message — a bot cannot open a chat from a @username.
 */
function intakeEmailWording({ contactName, company, replyChannel, telegram }) {
  return {
    name: contactName || "коллеги",
    org: company || "вашей компании",
    reply:
      replyChannel === "telegram" && telegram
        ? `Ответим в Telegram: ${telegram}`
        : "Ответим на этот email.",
  };
}

export function intakeEmailHtml(input) {
  const { name, org, reply } = intakeEmailWording(input);
  return (
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#11130f;">' +
    `<p>Здравствуйте, ${escapeHtml(name)}!</p>` +
    `<p>Мы получили анкету для настройки тендерного радара АПС и СОУЭ для ${escapeHtml(org)}.</p>` +
    `<p>${escapeHtml(reply)} Обычно отвечаем в течение рабочего дня.</p>` +
    "<p>Если появятся вопросы раньше — пишите в Telegram " +
    '<a href="https://t.me/kruger79">@kruger79</a> или на этот email.</p>' +
    "<p>— Команда ПожТендер</p>" +
    "</body></html>"
  );
}

export function intakeEmailText(input) {
  const { name, org, reply } = intakeEmailWording(input);
  return [
    `Здравствуйте, ${name}!`,
    "",
    `Мы получили анкету для настройки тендерного радара АПС и СОУЭ для ${org}.`,
    "",
    `${reply} Обычно отвечаем в течение рабочего дня.`,
    "",
    "Если появятся вопросы раньше — пишите в Telegram @kruger79 (https://t.me/kruger79) или на этот email.",
    "",
    "— Команда ПожТендер",
  ].join("\r\n");
}
