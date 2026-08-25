// The "your access is open" email, shared by the ResultURL handler and the
// administrative scripts so both send exactly the same message.
import { escapeHtml } from "./smtp.mjs";

/** Where a paid order continues. A subscription renewal needs no intake form. */
export function nextStepPath(plan) {
  return plan === "subscription" ? "/payment/success" : "/brief";
}

export function accessEmailSubject(invoiceId) {
  return `Оплата получена — заказ №${invoiceId} — ПожТендер`;
}

/**
 * The wording both representations share, so the plain-text alternative can
 * never drift away from what the HTML part says.
 */
function accessEmailWording({ plan, accessUntil }) {
  const isSubscription = plan === "subscription";
  return {
    action: isSubscription ? "Открыть подтверждение" : "Перейти к анкете",
    what: isSubscription
      ? "Обслуживание продлено — новая анкета не нужна, профиль компании уже настроен."
      : "Следующий шаг — короткая анкета для настройки радара.",
    until: new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(accessUntil),
    caution:
      "Ссылка открывает доступ в любом браузере и на любом устройстве, пока действует оплаченный период. Не пересылайте её третьим лицам.",
  };
}

/**
 * Builds the message body.
 *
 * Carries only what the customer needs: the order number, the amount, how long
 * access lasts and one link. No database ids, no session hashes, no internal
 * commands, nothing about the owner's own channels. The token appears only
 * inside the link.
 */
export function accessEmailHtml({ invoiceId, amount, plan, accessUntil, url }) {
  const { action, what, until, caution } = accessEmailWording({ plan, accessUntil });

  return [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#11130f;line-height:1.55;">',
    "<p><strong>Оплата получена.</strong></p>",
    `<p>Заказ №${escapeHtml(invoiceId)} на сумму ${escapeHtml(amount)} ₽ оплачен.</p>`,
    `<p>${escapeHtml(what)} Доступ активен до ${escapeHtml(until)}.</p>`,
    `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 18px;background:#d8ff3e;color:#11130f;font-weight:700;text-decoration:none;border:1px solid #11130f;">${escapeHtml(action)}</a></p>`,
    `<p style="color:#686b61;font-size:13px;">${escapeHtml(caution)}</p>`,
    "<p>— Команда ПожТендер</p>",
    "</body></html>",
  ].join("");
}

/**
 * The text/plain alternative of the same message. A transactional email with
 * no plain-text part is one of the traits Yandex scored as spam, and a mail
 * client that shows this part must still give the customer everything: what
 * was paid, for which order, how long access lasts and the link back in.
 *
 * Nothing is HTML-escaped here — this part is never parsed as markup — and no
 * value beyond the ones already in the HTML body appears.
 */
export function accessEmailText({ invoiceId, amount, plan, accessUntil, url }) {
  const { action, what, until, caution } = accessEmailWording({ plan, accessUntil });

  return [
    "Оплата получена.",
    "",
    `Заказ №${invoiceId} на сумму ${amount} ₽ оплачен.`,
    `${what} Доступ активен до ${until}.`,
    "",
    `${action}: ${url}`,
    "",
    caution,
    "",
    "— Команда ПожТендер",
  ].join("\r\n");
}
