import type { Metadata } from "next";
import { Footer, Header } from "../site-chrome";
import { BriefForm } from "./brief-form";
import { isIntakeAccessValid, type RobokassaEnvironment } from "../../lib/robokassa";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Анкета для запуска — ПожТендер",
  description: "Единая анкета для настройки тендерного радара ПожТендер.",
};

interface BriefPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function BriefPage({ searchParams }: BriefPageProps) {
  const parameters = await searchParams;
  const invoiceId = first(parameters.InvId);
  const outSum = first(parameters.OutSum);
  const accessExpires = first(parameters.expires);
  const accessToken = first(parameters.access);
  const env = process.env as RobokassaEnvironment;
  const hasAccess = Boolean(env.ROBOKASSA_PASSWORD_2) && await isIntakeAccessValid({
    invoiceId,
    outSum,
    expires: accessExpires,
    accessToken,
    password: env.ROBOKASSA_PASSWORD_2 ?? "",
  });

  if (!hasAccess) {
    return (
      <main>
        <Header />
        <section className="result-page shell">
          <span className="result-mark failed" aria-hidden="true">₽</span>
          <p className="eyebrow">Анкета доступна после оплаты</p>
          <h1>Сначала активируйте 7-дневную калибровку.</h1>
          <p>После подтверждённой оплаты Robokassa автоматически вернёт вас на персональную ссылку с анкетой. Обычная ссылка без платёжного пропуска отправку не открывает.</p>
          <a className="button button-primary" href="/payment">Перейти к оплате <span aria-hidden="true">→</span></a>
        </section>
        <Footer />
      </main>
    );
  }

  return (
    <main>
      <Header />
      <section className="brief-page shell">
        <header className="brief-heading">
          <p className="eyebrow">Единая точка старта</p>
          <h1>Настроим радар под вашу компанию</h1>
          <p>Заполните один раз и выберите, куда прислать ответ — в Telegram или на email. Пароли, ЭЦП, данные карт и доступы к ЭТП не нужны.</p>
        </header>
        <BriefForm
          invoiceId={invoiceId}
          outSum={outSum}
          accessExpires={accessExpires}
          accessToken={accessToken}
        />
      </section>
      <Footer />
    </main>
  );
}
