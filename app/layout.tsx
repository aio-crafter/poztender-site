import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = `${protocol}://${host}`;

  return {
    metadataBase: new URL(baseUrl),
    title: "ПожТендер — радар закупок по АПС и СОУЭ",
    description:
      "Предварительный отбор закупок по пожарной безопасности с объяснением: подходит, нужна проверка или исключено.",
    openGraph: {
      title: "ПожТендер — сразу видно: идти или нет",
      description: "Автономный радар закупок по АПС и СОУЭ для подрядчиков.",
      type: "website",
      locale: "ru_RU",
      url: baseUrl,
      images: [{ url: `${baseUrl}/og.png`, width: 1536, height: 1024, alt: "ПожТендер — радар закупок по АПС и СОУЭ" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "ПожТендер — сразу видно: идти или нет",
      description: "Автономный радар закупок по АПС и СОУЭ для подрядчиков.",
      images: [`${baseUrl}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
