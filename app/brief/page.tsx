import type { Metadata } from "next";
import { Footer, Header } from "../site-chrome";
import { BriefForm } from "./brief-form";

export const metadata: Metadata = {
  title: "Анкета для запуска — ПожТендер",
  description: "Единая анкета для настройки тендерного радара ПожТендер.",
};

interface BriefPageProps {
  searchParams: Promise<{ InvId?: string | string[] }>;
}

export default async function BriefPage({ searchParams }: BriefPageProps) {
  const parameters = await searchParams;
  const candidate = Array.isArray(parameters.InvId) ? parameters.InvId[0] : parameters.InvId;
  const invoiceId = candidate && /^\d{1,19}$/.test(candidate) ? candidate : "";

  return (
    <main>
      <Header />
      <section className="brief-page shell">
        <header className="brief-heading">
          <p className="eyebrow">Единая точка старта</p>
          <h1>Настроим радар под вашу компанию</h1>
          <p>Заполните один раз и выберите, куда прислать ответ — в Telegram или на email. Пароли, ЭЦП, данные карт и доступы к ЭТП не нужны.</p>
        </header>
        <BriefForm invoiceId={invoiceId} />
      </section>
      <Footer />
    </main>
  );
}
