import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Footer, Header, Steps } from "../../site-chrome";
import { CopyButton } from "./copy-button";
import { isDatabaseConfigured } from "../../../db";
import { findSelectedOrder, ORDER_STATUS } from "../../../lib/orders";
import {
  CHECKOUT_COOKIE,
  ORDER_COOKIE,
  isWellFormedSecret,
  readOrderSelector,
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

  const jar = await cookies();
  const secret = jar.get(CHECKOUT_COOKIE)?.value;
  // Both are required: the secret proves the session, the selector names which
  // of that session's orders this page is about.
  const invoiceId = readOrderSelector(jar.get(ORDER_COOKIE)?.value);
  if (!isWellFormedSecret(secret) || invoiceId === null) return null;

  try {
    const state = await findSelectedOrder(secret, invoiceId);
    return state?.order.buyerType === "business" ? state.order : null;
  } catch (error) {
    console.error("[invoice] lookup failed", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Turns the free-text BANK_TRANSFER_DETAILS into label/value rows for display.
 *
 * Presentation only — the variable stays the single source of the text and its
 * format is unchanged. A line reading `Label: value` becomes a row; anything
 * else is kept verbatim as a full-width line, so an unusual value still shows
 * up exactly as written rather than being dropped.
 */
function parseRequisites(details: string | undefined) {
  if (!details) return [];
  return details
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) return { label: null, value: line, numeric: false };
      const label = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      // Monospace belongs on account numbers and codes, not on names.
      return { label, value, numeric: /^[\d\s/-]{6,}$/.test(value) };
    });
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
  const requisites = parseRequisites(bankDetails);
  const accessDays = order.plan === "subscription" ? 30 : 7;
  const purpose = "Оплата услуг ПожТендер. НДС не облагается.";

  return (
    <main>
      <Header />
      <section className="payment-page shell">
        <div className="payment-copy">
          <Steps current={isPaid ? 2 : 1} />
          <p className="eyebrow">Оплата по счёту</p>
          <h1 className="invoice-heading">Оплата для ИП и организаций</h1>
          <p className="payment-lead">
            Оплата картой доступна только физическим лицам. Для ИП и организаций оплата
            принимается банковским переводом на расчётный счёт.
          </p>

          <div className="payment-facts">
            <div>
              <span>Номер заказа</span>
              <strong className="mono">{String(order.invoiceId)}</strong>
            </div>
            <div><span>Услуга</span><strong>{product.description}</strong></div>
            <div><span>Сумма</span><strong>{amount} ₽</strong></div>
            <div><span>Плательщик</span><strong>{order.buyerName}</strong></div>
            <div><span>ИНН</span><strong className="mono">{order.buyerInn}</strong></div>
            <div>
              <span>Статус</span>
              <strong>
                <span className={`status-pill${isPaid ? " paid" : ""}`}>
                  <span className="status-dot" aria-hidden="true" />
                  {isPaid ? "Оплачен" : "Ожидает оплаты"}
                </span>
              </strong>
            </div>
          </div>

          <p className="microcopy">
            НДС не облагается в связи с применением исполнителем налога на профессиональный доход.
          </p>
        </div>

        <aside className="checkout-card" aria-label="Реквизиты и порядок оплаты">
          {isPaid ? (
            <>
              <span className="price-name">Оплата получена</span>
              {/* A subscription renewal has no intake form, so it must not be
                  sent to /brief — that page refuses the plan and the customer
                  would hit a dead end. */}
              {order.plan === "subscription" ? (
                <>
                  <p>Обслуживание продлено ещё на месяц. Новая анкета не нужна — профиль компании уже настроен.</p>
                  <a className="button button-primary full" href="/payment/success">
                    Открыть подтверждение <span aria-hidden="true">→</span>
                  </a>
                </>
              ) : (
                <>
                  <p>Доступ к анкете открыт. Ссылку мы также отправили на {order.email}.</p>
                  <a className="button button-primary full" href="/brief">
                    Перейти к анкете <span aria-hidden="true">→</span>
                  </a>
                </>
              )}
            </>
          ) : (
            <>
              <section className="invoice-section">
                <h2 className="price-name">Реквизиты для оплаты</h2>
                {requisites.length > 0 ? (
                  <dl className="requisites">
                    {requisites.map((row, index) =>
                      row.label ? (
                        <div key={index}>
                          <dt>{row.label}</dt>
                          <dd className={row.numeric ? "mono" : undefined}>{row.value}</dd>
                        </div>
                      ) : (
                        <div key={index} className="requisites-note">
                          <dd>{row.value}</dd>
                        </div>
                      ),
                    )}
                  </dl>
                ) : (
                  <p>
                    Счёт на оплату и реквизиты мы вышлем на <strong>{order.email}</strong> в течение
                    рабочего дня. Если счёт нужен быстрее — напишите нам.
                  </p>
                )}
              </section>

              <section className="invoice-section">
                <h2 className="price-name">Назначение платежа</h2>
                <p className="invoice-purpose">{purpose}</p>
                <p className="invoice-order-note">Обязательно укажите номер заказа:</p>
                <p className="invoice-order-number mono">{String(order.invoiceId)}</p>
                <div className="copy-row">
                  <CopyButton value={String(order.invoiceId)} label="Скопировать номер" />
                  <CopyButton
                    value={`${purpose} Номер заказа ${order.invoiceId}.`}
                    label="Скопировать назначение"
                  />
                </div>
              </section>

              <section className="invoice-section">
                <h2 className="price-name">После оплаты</h2>
                <ol className="invoice-steps">
                  <li>Вы переводите оплату по указанным реквизитам.</li>
                  <li>Мы подтверждаем поступление платежа.</li>
                  <li>Формируем чек НПД и открываем доступ на {accessDays} дней.</li>
                </ol>
              </section>

              <p className="invoice-eta">
                <span aria-hidden="true">◷</span>
                Зачисление обычно занимает 1–3 рабочих дня. Мы сообщим на {order.email}.
              </p>
            </>
          )}
          <div className="invoice-contacts">
            <h2 className="price-name">Вопросы по счёту</h2>
            <ul>
              <li>
                <span>Telegram</span>
                <a href="https://t.me/kruger79" target="_blank" rel="noreferrer">@kruger79</a>
              </li>
              <li>
                <span>Email</span>
                <a href="mailto:beastsahsa@yandex.ru">beastsahsa@yandex.ru</a>
              </li>
            </ul>
          </div>
        </aside>
      </section>
      <Footer />
    </main>
  );
}
