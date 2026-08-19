import type { Metadata } from "next";
import { Footer, Header, Steps } from "../site-chrome";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Оплата калибровки — ПожТендер",
  description: "Онлайн-оплата 7-дневной калибровки ПожТендера.",
};

interface PaymentPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function PaymentPage({ searchParams }: PaymentPageProps) {
  const parameters = await searchParams;
  const error = first(parameters.error);

  return (
    <main>
      <Header />
      <section className="payment-page shell">
        <div className="payment-copy">
          <Steps current={1} />
          <p className="eyebrow">Безопасная онлайн-оплата</p>
          <h1>Запустить калибровку</h1>
          <p className="payment-lead">
            Оплата проходит на защищённой странице Robokassa. ПожТендер не получает и не хранит номер карты, CVV или коды подтверждения.
          </p>
          <div className="payment-facts">
            <div><span>Услуга</span><strong>Калибровка радара АПС/СОУЭ</strong></div>
            <div><span>Период</span><strong>7 календарных дней</strong></div>
            <div><span>Оплата</span><strong>Один раз, без автосписаний</strong></div>
            <div><span>Документ</span><strong>Электронный чек НПД</strong></div>
          </div>
        </div>

        <aside className="checkout-card" aria-label="Сумма и переход к оплате">
          <span className="price-name">К оплате</span>
          <div className="price">4 900 <small>₽</small></div>
          <p>Без НДС в связи с применением НПД.</p>
          {error === "email" && (
            <p className="checkout-error" role="alert">
              Не удалось распознать email. Проверьте адрес и попробуйте ещё раз.
            </p>
          )}
          {error === "rate" && (
            <p className="checkout-error" role="alert">
              Слишком много попыток оплаты подряд. Подождите несколько минут и попробуйте ещё раз.
            </p>
          )}
          {error === "store" && (
            <p className="checkout-error" role="alert">
              Не удалось начать оплату — заказ не был сохранён. Деньги не списаны. Повторите попытку через минуту или запросите счёт.
            </p>
          )}
          <form className="checkout-form" action="/api/payment/start" method="post">
            <label>
              Email для уведомления о платеже
              <input name="email" type="email" required maxLength={160} autoComplete="email" placeholder="name@company.ru" />
            </label>
            <button className="button button-primary full" type="submit">
              Оплатить онлайн <span aria-hidden="true">→</span>
            </button>
          </form>
          <div className="payment-badges" aria-label="Способы оплаты">
            <span>МИР</span>
            <span>VISA</span>
            <span>Mastercard</span>
            <span>СБП</span>
          </div>
          <p className="checkout-consent">
            Нажимая кнопку, вы принимаете <a href="/offer">публичную оферту</a> и подтверждаете ознакомление с <a href="/privacy">политикой данных</a>.
          </p>
          <div className="provider-note">
            <span aria-hidden="true">◆</span>
            <span>Карта, СБП и доступные способы оплаты показываются на стороне провайдера.</span>
          </div>
        </aside>
      </section>
      <Footer />
    </main>
  );
}
