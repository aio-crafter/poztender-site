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
  invoiceId: string;
}

type IntakeResult =
  | { ok: true; data: IntakeSubmission }
  | { ok: false; error: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEGRAM_PATTERN = /^@?[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

function clean(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.replaceAll("\u0000", "").trim().slice(0, maxLength)
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
  const telegramRaw = clean(input.telegram, 33);
  const replyChannel = clean(input.replyChannel, 16);
  const regions = clean(input.regions, 500);
  const workTypes = clean(input.workTypes, 1_200);
  const budget = clean(input.budget, 300);
  const licenses = clean(input.licenses, 800);
  const exclusions = clean(input.exclusions, 1_200);
  const invoiceId = clean(input.invoiceId, 19);

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
  if (replyChannel === "telegram" && !TELEGRAM_PATTERN.test(telegramRaw)) {
    return { ok: false, error: "Укажите Telegram в формате @username." };
  }
  if (regions.length < 2) {
    return { ok: false, error: "Укажите регионы поиска." };
  }
  if (workTypes.length < 5) {
    return { ok: false, error: "Опишите нужные виды работ." };
  }
  if (invoiceId && !/^\d{1,19}$/.test(invoiceId)) {
    return { ok: false, error: "Проверьте номер платежа." };
  }
  if (input.consent !== true) {
    return { ok: false, error: "Нужно подтвердить согласие на обработку данных." };
  }

  const telegram = telegramRaw
    ? `@${telegramRaw.replace(/^@/, "")}`
    : "";

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
      invoiceId,
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

export function createIntakeNotification(data: IntakeSubmission) {
  const reply = data.replyChannel === "telegram"
    ? `Telegram ${data.telegram}`
    : `email ${data.email}`;

  return [
    "<b>🔥 Новая анкета ПожТендера</b>",
    data.invoiceId ? line("Номер платежа", data.invoiceId) : "",
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
