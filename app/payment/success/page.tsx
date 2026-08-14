import type { Metadata } from "next";
import { Footer, Header } from "../../site-chrome";
import {
  createIntakeAccessToken,
  createResultSignature,
  isPaymentReady,
  planForAmount,
  safeEqualHex,
  type RobokassaEnvironment,
} from "../../../lib/robokassa";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Оплата принята — ПожТендер" };

interface PaymentSuccessPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function PaymentSuccessPage({ searchParams }: PaymentSuccessPageProps) {
  const parameters = await searchParams;
  const invoiceId = first(parameters.InvId);
  const outSum = first(parameters.OutSum);
  const receivedSignature = first(parameters.SignatureValue);
  const env = process.env as RobokassaEnvironment;
  const plan = planForAmount(outSum);
  let confirmed = false;

  if (
    isPaymentReady(env) &&
    /^\d{1,19}$/.test(invoiceId) &&
    plan &&
    /^[a-f\d]{64}$/i.test(receivedSignature)
  ) {
    const expectedSignature = await createResultSignature({
      outSum,
      invoiceId,
      password: env.ROBOKASSA_PASSWORD_1!,
    });
    confirmed = safeEqualHex(receivedSignature, expectedSignature);
  }

  if (confirmed && plan === "subscription") {
    return (
      <main>
        <Header />
        <section className="result-page shell">
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

  let briefUrl = "";
  if (confirmed && plan === "pilot") {
    const expires = String(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
    const access = await createIntakeAccessToken({
      invoiceId,
      outSum,
      expires,
      password: env.ROBOKASSA_PASSWORD_2!,
    });
    const query = new URLSearchParams({ InvId: invoiceId, OutSum: outSum, expires, access });
    briefUrl = `/brief?${query.toString()}`;
  }

  return (
    <main>
      <Header />
      <section className="result-page shell">
        <span className={`result-mark ${briefUrl ? "success" : "failed"}`} aria-hidden="true">{briefUrl ? "✓" : "!"}</span>
        <p className="eyebrow">{briefUrl ? "Платёж подтверждён" : "Подтверждение не получено"}</p>
        <h1>{briefUrl ? "Спасибо. Следующий шаг — профиль радара." : "Анкета пока закрыта."}</h1>
        <p>{briefUrl
          ? "Для старта заполните одну короткую анкету и выберите, куда получать ответы: в Telegram или на email. Ссылка действует 7 дней."
          : "Откройте эту страницу через кнопку возврата после успешной оплаты Robokassa. Если деньги списаны, но подтверждение не появилось, напишите нам — проверим платёж вручную."}</p>
        <a className="button button-primary" href={briefUrl || "/payment"}>{briefUrl ? "Заполнить профиль радара" : "Вернуться к оплате"} <span aria-hidden="true">→</span></a>
      </section>
      <Footer />
    </main>
  );
}
