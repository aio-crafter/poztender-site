import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Footer, Header, Steps } from "../../site-chrome";
import { isDatabaseConfigured } from "../../../db";
import { findSelectedOrder, isGrantActive } from "../../../lib/orders";
import {
  CHECKOUT_COOKIE,
  ORDER_COOKIE,
  isWellFormedSecret,
  readOrderSelector,
} from "../../../lib/payment-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Оплата принята — ПожТендер" };

type View = "paid-pilot" | "paid-subscription" | "pending" | "unknown";

/**
 * Read-only. This page proves nothing and creates nothing: no order status is
 * changed, no entitlement is issued and no token is minted. It resolves the
 * browser's checkout cookie to an order and reports what the server already
 * knows. The only thing that can mark an order paid is the ResultURL handler.
 *
 * The query parameters Robokassa appends here are deliberately ignored — they
 * are attacker-controlled, and treating them as evidence is what previously
 * allowed a single paid link to be replayed indefinitely.
 */
async function resolveView(): Promise<View> {
  if (!isDatabaseConfigured()) return "unknown";

  const jar = await cookies();
  const secret = jar.get(CHECKOUT_COOKIE)?.value;
  // Both are required: the secret proves the session, the selector names which
  // of that session's orders this page is about. Without it a customer who
  // already paid once would keep seeing that older order instead of this one.
  const invoiceId = readOrderSelector(jar.get(ORDER_COOKIE)?.value);
  if (!isWellFormedSecret(secret) || invoiceId === null) return "unknown";

  let state;
  try {
    state = await findSelectedOrder(secret, invoiceId);
  } catch (error) {
    console.error("[payment] success lookup failed", error instanceof Error ? error.message : error);
    return "unknown";
  }
  if (!state) return "unknown";

  if (state.order.status !== "paid") return "pending";
  if (state.order.plan === "subscription") return "paid-subscription";
  return isGrantActive(state.grant, state.order) ? "paid-pilot" : "pending";
}

export default async function PaymentSuccessPage() {
  const view = await resolveView();

  if (view === "paid-subscription") {
    return (
      <main>
        <Header />
        <section className="result-page shell">
          <Steps current={3} />
          <span className="result-mark success" aria-hidden="true">✓</span>
          <p className="eyebrow">Продление подтверждено</p>
          <h1>Спасибо. Обслуживание продлено ещё на месяц.</h1>
          <p>Радар продолжит присылать отбор закупок в выбранный ранее канал. Новая анкета не нужна — профиль компании уже настроен.</p>
          <a className="button button-primary" href="/">Вернуться на главную <span aria-hidden="true">→</span></a>
        </section>
        <Footer />
      </main>
    );
  }

  if (view === "paid-pilot") {
    return (
      <main>
        <Header />
        <section className="result-page shell">
          <Steps current={2} />
          <span className="result-mark success" aria-hidden="true">✓</span>
          <p className="eyebrow">Платёж подтверждён</p>
          <h1>Спасибо. Следующий шаг — профиль радара.</h1>
          <p>Для старта заполните одну короткую анкету и выберите, куда получать ответы: в Telegram или на email. Анкета доступна в этом браузере 7 дней.</p>
          <a className="button button-primary" href="/brief">Перейти к анкете <span aria-hidden="true">→</span></a>
        </section>
        <Footer />
      </main>
    );
  }

  if (view === "pending") {
    return (
      <main>
        <Header />
        <section className="result-page shell">
          <Steps current={1} />
          <span className="result-mark pending" aria-hidden="true">…</span>
          <p className="eyebrow">Платёж обрабатывается</p>
          <h1>Ждём подтверждение от банка.</h1>
          <p>Обычно это занимает несколько секунд. Обновите страницу через минуту — как только Robokassa подтвердит оплату, здесь появится ссылка на анкету.</p>
          <a className="button button-primary" href="/payment/success">Обновить <span aria-hidden="true">→</span></a>
          <p className="microcopy">Если деньги списаны, но подтверждение не появляется дольше 15 минут, напишите нам: <a href="https://t.me/kruger79" target="_blank" rel="noreferrer">@kruger79</a> или <a href="mailto:beastsahsa@yandex.ru">beastsahsa@yandex.ru</a> — проверим платёж вручную.</p>
        </section>
        <Footer />
      </main>
    );
  }

  return (
    <main>
      <Header />
      <section className="result-page shell">
        <span className="result-mark failed" aria-hidden="true">!</span>
        <p className="eyebrow">Подтверждение не получено</p>
        <h1>Анкета пока закрыта.</h1>
        <p>Откройте эту страницу в том же браузере, из которого начинали оплату — иначе мы не сможем связать её с вашим заказом. Если деньги списаны, а подтверждение не появилось, напишите нам — проверим платёж вручную.</p>
        <a className="button button-primary" href="/payment">Вернуться к оплате <span aria-hidden="true">→</span></a>
      </section>
      <Footer />
    </main>
  );
}
