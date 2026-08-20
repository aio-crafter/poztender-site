import type { Metadata } from "next";
import { Footer, Header } from "../../site-chrome";

export const metadata: Metadata = { title: "Ссылка недействительна — ПожТендер" };

/**
 * Where a failed recovery lands. Deliberately says nothing about whether the
 * order exists, whether it was paid or why the link did not work — the endpoint
 * must not become a way to probe orders.
 */
export default function AccessLinkExpiredPage() {
  return (
    <main>
      <Header />
      <section className="result-page shell">
        <span className="result-mark failed" aria-hidden="true">!</span>
        <p className="eyebrow">Ссылка не сработала</p>
        <h1>Ссылка недействительна или срок доступа истёк.</h1>
        <p>
          Ссылки из письма действуют, пока действует оплаченный период. Если оплата была
          недавно и доступ должен быть активен — напишите нам, вышлем новую ссылку.
        </p>
        <div className="hero-actions">
          <a className="button button-primary" href="https://t.me/kruger79" target="_blank" rel="noreferrer">
            Написать в Telegram <span aria-hidden="true">→</span>
          </a>
          <a className="button button-secondary" href="mailto:beastsahsa@yandex.ru">Написать на email</a>
        </div>
      </section>
      <Footer />
    </main>
  );
}
