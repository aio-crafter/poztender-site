import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Footer, Header, Steps } from "../site-chrome";
import { BriefForm } from "./brief-form";
import { isDatabaseConfigured } from "../../db";
import { findOrderBySessionHash, isGrantActive } from "../../lib/orders";
import {
  CHECKOUT_COOKIE,
  hashSessionSecret,
  isWellFormedSecret,
} from "../../lib/payment-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Анкета для запуска — ПожТендер",
  description: "Единая анкета для настройки тендерного радара ПожТендер.",
};

/**
 * Access is decided entirely from server state: the cookie identifies the
 * order, and the order must be paid with a live, unrevoked, unspent grant.
 * Nothing in the URL contributes, so there is no longer any way to construct
 * a link that opens the form.
 */
async function hasPaidAccess() {
  if (!isDatabaseConfigured()) return false;

  const secret = (await cookies()).get(CHECKOUT_COOKIE)?.value;
  if (!isWellFormedSecret(secret)) return false;

  try {
    const state = await findOrderBySessionHash(await hashSessionSecret(secret));
    if (!state || state.order.plan !== "pilot") return false;
    if (state.grant?.usedAt) return false;
    return isGrantActive(state.grant, state.order);
  } catch (error) {
    console.error("[brief] access lookup failed", error instanceof Error ? error.message : error);
    return false;
  }
}

export default async function BriefPage() {
  if (!(await hasPaidAccess())) {
    return (
      <main>
        <Header />
        <section className="result-page shell">
          <span className="result-mark failed" aria-hidden="true">₽</span>
          <p className="eyebrow">Анкета доступна после оплаты</p>
          <h1>Сначала активируйте 7-дневную калибровку.</h1>
          <p>Анкета открывается в том же браузере, из которого вы оплачивали, после подтверждения платежа. Если анкета уже отправлена, повторно она не открывается.</p>
          <a className="button button-primary" href="/payment">Перейти к оплате <span aria-hidden="true">→</span></a>
          <p className="microcopy">Уже оплатили, но анкета не открывается? Напишите нам: <a href="https://t.me/kruger79" target="_blank" rel="noreferrer">@kruger79</a> или <a href="mailto:beastsahsa@yandex.ru">beastsahsa@yandex.ru</a> — вышлем анкету вручную.</p>
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
