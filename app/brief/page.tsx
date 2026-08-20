import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Footer, Header, Steps } from "../site-chrome";
import { BriefForm } from "./brief-form";
import { isDatabaseConfigured } from "../../db";
import { findSelectedOrder, isGrantActive } from "../../lib/orders";
import {
  CHECKOUT_COOKIE,
  ORDER_COOKIE,
  isWellFormedSecret,
  readOrderSelector,
} from "../../lib/payment-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Анкета для запуска — ПожТендер",
  description: "Единая анкета для настройки тендерного радара ПожТендер.",
};

/**
 * Three outcomes, not two.
 *
 * The page must tell "never paid" apart from "paid and already submitted":
 * showing a customer who has just sent their form a screen that says to pay
 * first reads as though their money vanished. Access itself is still decided
 * entirely from server state — the cookie only identifies the order.
 */
type BriefState = "payment-required" | "open" | "completed";

async function resolveState(): Promise<{ state: BriefState; submittedAt?: Date }> {
  if (!isDatabaseConfigured()) return { state: "payment-required" };

  const jar = await cookies();
  const secret = jar.get(CHECKOUT_COOKIE)?.value;
  // Both are required: the secret proves the session, the selector names which
  // of that session's orders this page is about.
  const invoiceId = readOrderSelector(jar.get(ORDER_COOKIE)?.value);
  if (!isWellFormedSecret(secret) || invoiceId === null) return { state: "payment-required" };

  try {
    const found = await findSelectedOrder(secret, invoiceId);
    if (!found || found.order.plan !== "pilot") return { state: "payment-required" };
    if (found.grant?.usedAt) {
      return { state: "completed", submittedAt: found.grant.usedAt };
    }
    return isGrantActive(found.grant, found.order)
      ? { state: "open" }
      : { state: "payment-required" };
  } catch (error) {
    console.error("[brief] access lookup failed", error instanceof Error ? error.message : error);
    return { state: "payment-required" };
  }
}

export default async function BriefPage() {
  const { state, submittedAt } = await resolveState();

  if (state === "completed") {
    const sent = submittedAt
      ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short" }).format(submittedAt)
      : null;
    return (
      <main>
        <Header />
        <section className="result-page shell">
          <Steps current={3} />
          <span className="result-mark success" aria-hidden="true">✓</span>
          <p className="eyebrow">Анкета уже отправлена</p>
          <h1>Мы получили данные.</h1>
          <p>
            Повторно заполнять анкету не нужно. Ответственный за запуск уже видит вашу заявку и
            ответит выбранным способом связи в течение рабочего дня.
            {sent ? ` Анкета отправлена ${sent}.` : ""}
          </p>
          <a className="button button-primary" href="/">Вернуться на главную <span aria-hidden="true">→</span></a>
          <p className="microcopy">
            Нужно что-то уточнить или дополнить? Напишите нам: <a href="https://t.me/kruger79" target="_blank" rel="noreferrer">@kruger79</a>{" "}
            или <a href="mailto:beastsahsa@yandex.ru">beastsahsa@yandex.ru</a>.
          </p>
        </section>
        <Footer />
      </main>
    );
  }

  if (state === "payment-required") {
    return (
      <main>
        <Header />
        <section className="result-page shell">
          <Steps current={1} />
          <span className="result-mark failed" aria-hidden="true">₽</span>
          <p className="eyebrow">Анкета доступна после оплаты</p>
          <h1>Сначала активируйте 7-дневную калибровку.</h1>
          <p>Анкета открывается после подтверждения платежа. Если вы уже оплатили — откройте ссылку из письма о подтверждении оплаты, она работает в любом браузере.</p>
          <a className="button button-primary" href="/payment">Перейти к оплате <span aria-hidden="true">→</span></a>
          <p className="microcopy">Уже оплатили, но анкета не открывается? Напишите нам: <a href="https://t.me/kruger79" target="_blank" rel="noreferrer">@kruger79</a> или <a href="mailto:beastsahsa@yandex.ru">beastsahsa@yandex.ru</a> — вышлем новую ссылку.</p>
        </section>
        <Footer />
      </main>
    );
  }

  return (
    <main>
      <Header />
      <section className="brief-page shell">
        <header className="brief-heading">
          <Steps current={2} />
          <p className="eyebrow">Единая точка старта</p>
          <h1>Настроим радар под вашу компанию</h1>
          <p>Заполните один раз и выберите, куда прислать ответ — в Telegram или на email. Пароли, ЭЦП, данные карт и доступы к ЭТП не нужны.</p>
        </header>
        <BriefForm />
      </section>
      <Footer />
    </main>
  );
}
