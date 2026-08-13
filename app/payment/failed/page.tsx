import type { Metadata } from "next";
import { Footer, Header } from "../../site-chrome";

export const metadata: Metadata = { title: "Оплата не завершена — ПожТендер" };

export default function PaymentFailedPage() {
  return (
    <main>
      <Header />
      <section className="result-page shell">
        <span className="result-mark failed" aria-hidden="true">×</span>
        <p className="eyebrow">Деньги не списаны</p>
        <h1>Оплата не завершена.</h1>
        <p>Можно повторить платёж или запросить обычный счёт для оплаты со счёта организации.</p>
        <div className="hero-actions">
          <a className="button button-primary" href="/payment">Повторить <span aria-hidden="true">→</span></a>
          <a className="button button-secondary" href="mailto:beastsahsa@yandex.ru?subject=%D0%9F%D0%BE%D0%B6%D0%A2%D0%B5%D0%BD%D0%B4%D0%B5%D1%80%20%E2%80%94%20%D1%81%D1%87%D1%91%D1%82">Запросить счёт</a>
        </div>
      </section>
      <Footer />
    </main>
  );
}
