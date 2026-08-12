import type { Metadata } from "next";
import { Footer, Header } from "../../site-chrome";

export const metadata: Metadata = { title: "Оплата подключается — ПожТендер" };

export default function PaymentUnavailablePage() {
  return (
    <main>
      <Header />
      <section className="result-page shell">
        <span className="result-mark pending" aria-hidden="true">…</span>
        <p className="eyebrow">Платёжный канал ещё не активирован</p>
        <h1>Онлайн-оплата подключается.</h1>
        <p>Пока можно получить обычный счёт-оферту и оплатить его банковским переводом.</p>
        <a className="button button-primary" href="mailto:beastsahsa@yandex.ru?subject=%D0%9F%D0%BE%D0%B6%D0%A2%D0%B5%D0%BD%D0%B4%D0%B5%D1%80%20%E2%80%94%20%D1%81%D1%87%D1%91%D1%82">Получить счёт <span aria-hidden="true">→</span></a>
      </section>
      <Footer />
    </main>
  );
}

