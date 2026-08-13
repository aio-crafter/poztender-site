import type { Metadata } from "next";
import { Footer, Header } from "../site-chrome";

export const metadata: Metadata = {
  title: "Оплата калибровки — ПожТендер",
  description: "Онлайн-оплата 7-дневной калибровки ПожТендера.",
};

export default function PaymentPage() {
  return (
    <main>
      <Header />
      <section className="payment-page shell">
        <div className="payment-copy">
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
          <a className="button button-primary full" href="/api/payment/start">
            Оплатить онлайн <span aria-hidden="true">→</span>
          </a>
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
