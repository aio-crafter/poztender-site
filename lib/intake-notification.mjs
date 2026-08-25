// The owner's Telegram notification for a submitted intake form.
//
// Lives here, not in intake.ts, because scripts/resend-intake-notifications
// runs straight from source with no build step: sharing one builder is what
// keeps a re-sent notification identical to the original.
export function escapeTelegramHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function line(label, value) {
  return `<b>${label}:</b> ${escapeTelegramHtml(value || "—")}`;
}

/**
 * The invoice number and buyer details are passed in from the confirmed order
 * rather than taken from the submission: they describe a real payment, so they
 * must not be something the sender can choose.
 */
export function createIntakeNotification(data, invoiceId, buyer) {
  const reply = data.replyChannel === "telegram"
    ? `Telegram ${data.telegram}`
    : `email ${data.email}`;

  // Robokassa has no field for the buyer's tax details, so a receipt for an
  // organisation or sole trader has to be issued by hand in «Мой налог».
  // Carrying the requisites here is what makes that possible at all — see
  // AUDIT_REPORT.md, section on B2B receipts.
  const businessReceipt = buyer?.buyerType === "business"
    ? [
        "",
        "<b>⚠️ Чек НПД юрлицу — выставить вручную в «Мой налог»</b>",
        line("Плательщик", buyer.buyerName ?? ""),
        line("ИНН плательщика", buyer.buyerInn ?? ""),
      ]
    : [];

  return [
    "<b>🔥 Новая анкета ПожТендера</b>",
    invoiceId ? line("Номер платежа", invoiceId) : "",
    ...businessReceipt,
    line("Компания", data.company),
    line("ИНН", data.inn),
    line("Контакт", data.contactName),
    line("Ответить", reply),
    line("Email", data.email),
    line("Telegram", data.telegram),
    "",
    line("Регионы", data.regions),
    line("Виды работ", data.workTypes),
    line("Диапазон НМЦК", data.budget),
    line("Лицензии и допуски", data.licenses),
    line("Стоп-факторы", data.exclusions),
  ].filter((entry, index, entries) => entry || entries[index - 1]).join("\n").slice(0, 4_000);
}
