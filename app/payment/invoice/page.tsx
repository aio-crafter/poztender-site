import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Footer, Header, Steps } from "../../site-chrome";
import { isDatabaseConfigured } from "../../../db";
import { findOrderBySessionHash, ORDER_STATUS } from "../../../lib/orders";
import {
  CHECKOUT_COOKIE,
  hashSessionSecret,
  isWellFormedSecret,
} from "../../../lib/payment-session";
import { productForPlan } from "../../../lib/robokassa";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Оплата для ИП и организаций — ПожТендер" };

/**
 * Read-only, like the Robokassa success page: it reports what the server
 * already knows about the order this browser started and never changes it.
 */
async function loadOrder() {
  if (!isDatabaseConfigured()) return null;

  const secret = (await cookies()).get(CHECKOUT_COOKIE)?.value;
  if (!isWellFormedSecret(secret)) return null;

  try {
    const state = await findOrderBySessionHash(await hashSessionSecret(secret));
    return state?.order.buyerType === "business" ? state.order : null;
  } catch (error) {
    console.error("[invoice] lookup failed", error instanceof Error ? error.message : error);
    return null;
  }
}

export default async function PaymentInvoicePage() {
  const order = await loadOrder();

  if (!order) {
    return (
      <main>
        <Header />
        <section className="result-page shell">
          <span className="result-mark failed" aria-hidden="true">!</span>
          <p className="eyebrow">Заказ не найден</p>
          <h1>Счёт не сформирован.</h1>
          <p>Откройте страницу в том же браузере, где оформляли заказ, или оформите заказ заново.</p>
          <a className="button button-primary" href="/payment">Вернуться к оплате <span aria-hidden="true">→</span></a>
        </section>
        <Footer />
      </main>
    );
  }

  const product = productForPlan(order.plan);
  const amount = Number(order.expectedAmount).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
  });
  const isPaid = order.status === ORDER_STATUS.paid;
  // Requisites belong to the seller and are never hard-coded here. When they
  // are not configured, the page falls back to sending an invoice by email.
  const bankDetails = process.env.BANK_TRANSFER_DETAILS?.trim();

  return (
    <main>
      <Header />
      <section className="payment-page shell">
        <div className="payment-copy">
          <Steps current={1} />
          <p className="eyebrow">Оплата по счёту</p>
          <h1>Оплата для ИП и организаций</h1>
          <p className="payment-lead">
            Оплата картой на этой странице доступна только физическим лицам. Для ИП и
            организаций оплата принимается банковским переводом на расчётный счёт.
          </p>

          <div className="payment-facts">
            <div><span>Номер заказа</span><strong>{String(order.invoiceId)}</strong></div>
            <div><span>Услуга</span><strong>{product.description}</strong></div>
            <div><span>Сумма</span><strong>{amount} ₽</strong></div>
            <div><span>Плательщик</span><strong>{order.buyerName}</strong></div>
            <div><span>ИНН</span><strong>{order.buyerInn}</strong></div>
            <div><span>Статус</span><strong>{isPaid ? "Оплачен" : "Ожидает оплаты"}</strong></div>
          </div>

          <p className="microcopy">
            НДС не облагается в связи с применением исполнителем налога на профессиональный доход.
            В назначении платежа укажите номер заказа {String(order.invoiceId)}.
          </p>
        </div>

        <aside className="checkout-card" aria-label="Реквизиты и порядок оплаты">
          {isPaid ? (
            <>
              <span className="price-name">Оплата получена</span>
              <p>Доступ к анкете открыт в этом браузере.</p>
              <a className="button button-primary full" href="/brief">
                Заполнить профиль радара <span aria-hidden="true">→</span>
              </a>
            </>
          ) : (
            <>
              <span className="price-name">Как оплатить</span>
              {bankDetails ? (
                <pre className="bank-details">{bankDetails}</pre>
              ) : (
                <p>
                  Счёт на оплату и реквизиты мы вышлем на <strong>{order.email}</strong> в течение
                  рабочего дня. Если счёт нужен быстрее — напишите нам.
                </p>
              )}
              <ol className="invoice-steps">
                <li>Оплатите счёт с расчётного счёта организации или ИП.</li>
                <li>Укажите в назначении платежа номер заказа {String(order.invoiceId)}.</li>
                <li>
                  После поступления оплаты мы сформируем чек НПД на {order.buyerName} с указанием
                  ИНН {order.buyerInn} и откроем доступ к анкете.
                </li>
              </ol>
              <p className="checkout-consent">
                Зачисление обычно занимает 1–3 рабочих дня. Мы сообщим на {order.email}, как только
                оплата поступит.
              </p>
            </>
          )}
          <div className="provider-note">
            <span aria-hidden="true">◆</span>
            <span>
              Вопросы по счёту: <a href="https://t.me/kruger79" target="_blank" rel="noreferrer">@kruger79</a>{" "}
              или <a href="mailto:beastsahsa@yandex.ru">beastsahsa@yandex.ru</a>
            </span>
          </div>
        </aside>
      </section>
      <Footer />
    </main>
  );
}
