import type { Metadata } from "next";
import { Footer, Header } from "../../site-chrome";

export const metadata: Metadata = { title: "Оплата принята — ПожТендер" };

export default function PaymentSuccessPage() {
  return (
    <main>
      <Header />
      <section className="result-page shell">
        <span className="result-mark success" aria-hidden="true">✓</span>
        <p className="eyebrow">Платёж передан в обработку</p>
        <h1>Спасибо. Следующий шаг — профиль радара.</h1>
        <p>Квитанция и ссылка на чек придут на email, указанный при оплате. Для старта пришлите реквизиты компании и критерии отбора в Telegram — мы сверим оплату в кабинете провайдера.</p>
        <a className="button button-primary" href="https://t.me/kruger79" target="_blank" rel="noreferrer">Передать критерии <span aria-hidden="true">↗</span></a>
      </section>
      <Footer />
    </main>
  );
}

