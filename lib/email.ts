import { escapeHtml, isEmailReady, sendMail } from "./smtp.mjs";

export interface EmailEnvironment {
  YANDEX_SMTP_USER?: string;
  YANDEX_SMTP_PASSWORD?: string;
}

interface ConfirmationInput {
  to: string;
  company: string;
  contactName: string;
}

export { isEmailReady };

function buildIntakeHtml(contactName: string, company: string) {
  const safeName = escapeHtml(contactName || "коллеги");
  const safeCompany = escapeHtml(company || "вашей компании");
  return (
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#11130f;">' +
    `<p>Здравствуйте, ${safeName}!</p>` +
    `<p>Мы получили анкету для настройки тендерного радара АПС и СОУЭ для ${safeCompany}.</p>` +
    "<p>Ответим выбранным способом связи в течение рабочего дня. Если появятся вопросы раньше — пишите в Telegram " +
    '<a href="https://t.me/kruger79">@kruger79</a> или на этот email.</p>' +
    "<p>— Команда ПожТендер</p>" +
    "</body></html>"
  );
}

/**
 * Best-effort confirmation to the customer after their intake is delivered.
 * Any failure is reported as `false` and never blocks a paid submission.
 */
export async function sendIntakeConfirmationEmail(
  env: EmailEnvironment,
  input: ConfirmationInput,
): Promise<boolean> {
  return sendMail(env, {
    to: input.to,
    subject: "Анкета получена — ПожТендер",
    html: buildIntakeHtml(input.contactName, input.company),
  });
}
