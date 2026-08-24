import { intakeEmailHtml, intakeEmailSubject, intakeEmailText } from "./intake-email.mjs";
import type { ReplyChannel } from "./intake";
import { isEmailReady, sendMail } from "./smtp.mjs";

export interface EmailEnvironment {
  YANDEX_SMTP_USER?: string;
  YANDEX_SMTP_PASSWORD?: string;
}

interface ConfirmationInput {
  to: string;
  company: string;
  contactName: string;
  /** The channel the customer chose in the form; used for wording only. */
  replyChannel: ReplyChannel;
  /** The customer's Telegram contact, empty unless they chose that channel. */
  telegram: string;
}

export { isEmailReady };

/**
 * Best-effort confirmation to the customer after their intake is delivered.
 * Any failure is reported as `false` and never blocks a paid submission.
 */
export async function sendIntakeConfirmationEmail(
  env: EmailEnvironment,
  input: ConfirmationInput,
): Promise<boolean> {
  const content = {
    contactName: input.contactName,
    company: input.company,
    replyChannel: input.replyChannel,
    telegram: input.telegram,
  };
  return sendMail(env, {
    to: input.to,
    subject: intakeEmailSubject(),
    html: intakeEmailHtml(content),
    text: intakeEmailText(content),
  });
}
