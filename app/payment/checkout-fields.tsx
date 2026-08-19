"use client";

import { useState } from "react";

type BuyerType = "individual" | "business";

interface CheckoutFieldsProps {
  /** Shown when the server rejected the previous attempt. */
  error?: string;
}

const MESSAGES: Record<string, string> = {
  email: "Не удалось распознать email. Проверьте адрес и попробуйте ещё раз.",
  inn: "Проверьте ИНН: 10 цифр для организации или 12 для ИП, без пробелов.",
  name: "Укажите наименование организации или ИП, как в реквизитах.",
  store: "Не удалось начать оплату — заказ не был сохранён. Деньги не списаны. Повторите попытку через минуту или запросите счёт.",
  rate: "Слишком много попыток оплаты подряд. Подождите несколько минут и попробуйте ещё раз.",
};

/**
 * Buyer details for the receipt. The fields shown here are a convenience only —
 * every rule is re-checked on the server, which treats anything other than the
 * literal "business" as an individual buyer.
 */
export function CheckoutFields({ error }: CheckoutFieldsProps) {
  const [buyerType, setBuyerType] = useState<BuyerType>("individual");
  const message = error ? MESSAGES[error] : undefined;

  return (
    <>
      {message && (
        <p className="checkout-error" role="alert">
          {message}
        </p>
      )}

      <fieldset className="buyer-choice">
        <legend>Кто оплачивает</legend>
        <label className={buyerType === "individual" ? "selected" : ""}>
          <input
            type="radio"
            name="buyerType"
            value="individual"
            checked={buyerType === "individual"}
            onChange={() => setBuyerType("individual")}
          />
          <strong>Физическое лицо</strong>
          <small>Чек НПД придёт на email</small>
        </label>
        <label className={buyerType === "business" ? "selected" : ""}>
          <input
            type="radio"
            name="buyerType"
            value="business"
            checked={buyerType === "business"}
            onChange={() => setBuyerType("business")}
          />
          <strong>ИП или организация</strong>
          <small>Нужны ИНН и наименование</small>
        </label>
      </fieldset>

      <label>
        Email для чека и уведомления о платеже
        <input
          name="email"
          type="email"
          required
          maxLength={160}
          autoComplete="email"
          placeholder="name@company.ru"
        />
      </label>

      {buyerType === "business" && (
        <>
          <label>
            Наименование организации или ИП <b>*</b>
            <input
              name="buyerName"
              required
              maxLength={200}
              autoComplete="organization"
              placeholder="ООО «Монтаж-ПожСервис»"
            />
          </label>
          <label>
            ИНН <b>*</b>
            <input
              name="buyerInn"
              required
              inputMode="numeric"
              pattern="\d{10}|\d{12}"
              maxLength={12}
              placeholder="10 цифр для организации, 12 для ИП"
            />
            <span className="field-hint">
              Реквизиты попадут в чек НПД. Проверьте их до оплаты — после проведения платежа
              чек не переоформляется автоматически.
            </span>
          </label>
        </>
      )}
    </>
  );
}
