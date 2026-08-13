import type { Metadata } from "next";
import { Footer, Header } from "../../site-chrome";

export const metadata: Metadata = { title: "Оплата принята — ПожТендер" };

interface PaymentSuccessPageProps {
  searchParams: Promise<{ InvId?: string | string[] }>;
}

export default async function PaymentSuccessPage({ searchParams }: PaymentSuccessPageProps) {
  const parameters = await searchParams;
  const candidate = Array.isArray(parameters.InvId) ? parameters.InvId[0] : parameters.InvId;
  const briefUrl = candidate && /^\d{1,19}$/.test(candidate)
    ? `/brief?InvId=${encodeURIComponent(candidate)}`
    : "/brief";

  return (
    <main>
      <Header />
      <section className="result-page shell">
        <span className="result-mark success" aria-hidden="true">✓</span>
        <p className="eyebrow">Платёж передан в обработку</p>
        <h1>Спасибо. Следующий шаг — профиль радара.</h1>
        <p>Если провайдер запросил email, уведомление о платеже придёт на него. Для старта заполните одну короткую анкету и выберите, куда получать ответы: в Telegram или на email.</p>
        <a className="button button-primary" href={briefUrl}>Заполнить профиль радара <span aria-hidden="true">→</span></a>
      </section>
      <Footer />
    </main>
  );
}
