export type ReplyChannel = "telegram" | "email";

export interface IntakeSubmission {
  company: string;
  inn: string;
  contactName: string;
  email: string;
  telegram: string;
  replyChannel: ReplyChannel;
  regions: string;
  workTypes: string;
  budget: string;
  licenses: string;
  exclusions: string;
}

type IntakeResult =
  | { ok: true; data: IntakeSubmission }
  | { ok: false; error: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEGRAM_USERNAME_PATTERN = /^@?[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
const TELEGRAM_PHONE_PATTERN = /^\+?\d[\d\s\-()]{8,17}\d$/;
const NULL_BYTE = String.fromCharCode(0);

function clean(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.split(NULL_BYTE).join("").trim().slice(0, maxLength)
    : "";
}

export function validateIntakeSubmission(value: unknown): IntakeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Некорректные данные анкеты." };
  }

  const input = value as Record<string, unknown>;
  if (clean(input.website, 200)) {
    return { ok: false, error: "Анкета не прошла проверку." };
  }

  const company = clean(input.company, 160);
  const inn = clean(input.inn, 12).replace(/\s+/g, "");
  const contactName = clean(input.contactName, 100);
  const email = clean(input.email, 160).toLowerCase();
  const telegramRaw = clean(input.telegram, 40);
  const replyChannel = clean(input.replyChannel, 16);
  const regions = clean(input.regions, 500);
  const workTypes = clean(input.workTypes, 1_200);
  const budget = clean(input.budget, 300);
  const licenses = clean(input.licenses, 800);
  const exclusions = clean(input.exclusions, 1_200);

  if (company.length < 2) {
    return { ok: false, error: "Укажите название компании." };
  }
  if (!/^(?:\d{10}|\d{12})$/.test(inn)) {
    return { ok: false, error: "ИНН должен содержать 10 или 12 цифр." };
  }
  if (contactName.length < 2) {
    return { ok: false, error: "Укажите контактное лицо." };
  }
  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, error: "Проверьте email." };
  }
  if (replyChannel !== "telegram" && replyChannel !== "email") {
    return { ok: false, error: "Выберите способ получения ответа." };
  }
  const telegramIsUsername = TELEGRAM_USERNAME_PATTERN.test(telegramRaw);
  const telegramIsPhone = TELEGRAM_PHONE_PATTERN.test(telegramRaw);
  if (replyChannel === "telegram" && !telegramIsUsername && !telegramIsPhone) {
    return { ok: false, error: "Укажите Telegram в формате @username или номер телефона." };
  }
  if (regions.length < 2) {
    return { ok: false, error: "Укажите регионы поиска." };
  }
  if (workTypes.length < 5) {
    return { ok: false, error: "Опишите нужные виды работ." };
  }
  if (input.consent !== true) {
    return { ok: false, error: "Нужно подтвердить согласие на обработку данных." };
  }

  const telegram = telegramIsUsername
    ? `@${telegramRaw.replace(/^@/, "")}`
    : telegramRaw;

  return {
    ok: true,
    data: {
      company,
      inn,
      contactName,
      email,
      telegram,
      replyChannel,
      regions,
      workTypes,
      budget,
      licenses,
      exclusions,
    },
  };
}

function escapeTelegramHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function line(label: string, value: string) {
  return `<b>${label}:</b> ${escapeTelegramHtml(value || "—")}`;
}

// The invoice number is passed in from the confirmed order rather than taken
// from the submission: it identifies a real payment, so it must not be
// something the sender can choose.
export function createIntakeNotification(data: IntakeSubmission, invoiceId?: string) {
  const reply = data.replyChannel === "telegram"
    ? `Telegram ${data.telegram}`
    : `email ${data.email}`;

  return [
    "<b>🔥 Новая анкета ПожТендера</b>",
    invoiceId ? line("Номер платежа", invoiceId) : "",
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
