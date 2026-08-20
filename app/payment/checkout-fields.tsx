"use client";

import { useId, useState } from "react";

type BuyerType = "individual" | "business";

interface CheckoutFieldsProps {
  /** Shown when the server rejected the previous attempt. */
  error?: string;
  /** Call to action for a card payment; the bank-transfer label is fixed. */
  individualLabel: string;
}

const MESSAGES: Record<string, string> = {
  email: "Не удалось распознать email. Проверьте адрес и попробуйте ещё раз.",
  inn: "Проверьте ИНН: 10 цифр для организации или 12 для ИП, без пробелов.",
  name: "Укажите наименование организации или ИП, как в реквизитах.",
  store: "Не удалось начать оплату — заказ не был сохранён. Деньги не списаны. Повторите попытку через минуту или запросите счёт.",
  rate: "Слишком много попыток оплаты подряд. Подождите несколько минут и попробуйте ещё раз.",
};

const OPTIONS: Array<{
  value: BuyerType;
  title: string;
  requirement: string;
  method: string;
}> = [
  {
    value: "individual",
    title: "Физическое лицо",
    requirement: "Чек НПД придёт на email",
    method: "Оплата картой / СБП через Robokassa",
  },
  {
    value: "business",
    title: "ИП или организация",
    requirement: "Нужны ИНН и наименование",
    method: "Оплата банковским переводом",
  },
];

/**
 * Buyer details for the receipt. The fields shown here are a convenience only —
 * every rule is re-checked on the server, which treats anything other than the
 * literal "business" as an individual buyer.
 */
export function CheckoutFields({ error, individualLabel }: CheckoutFieldsProps) {
  const [buyerType, setBuyerType] = useState<BuyerType>("individual");
  const message = error ? MESSAGES[error] : undefined;
  const groupId = useId();
  const isBusiness = buyerType === "business";

  return (
    <>
      {message && (
        <p className="checkout-error" role="alert">
          {message}
        </p>
      )}

      <fieldset className="buyer-choice">
        <legend>Кто оплачивает</legend>
        <div className="buyer-options">
          {OPTIONS.map((option) => {
            const selected = buyerType === option.value;
            return (
              <label
                key={option.value}
                className={`buyer-option${selected ? " selected" : ""}`}
                htmlFor={`${groupId}-${option.value}`}
              >
                <input
                  id={`${groupId}-${option.value}`}
                  type="radio"
                  name="buyerType"
                  value={option.value}
                  checked={selected}
                  onChange={() => setBuyerType(option.value)}
                />
                {/* The mark carries the state without relying on colour: it is
                    empty when unselected and shows a tick when selected. */}
                <span className="buyer-option-mark" aria-hidden="true">
                  {selected ? "✓" : ""}
                </span>
                <span className="buyer-option-body">
                  <strong>{option.title}</strong>
                  <small>{option.requirement}</small>
                  <small className="buyer-option-method">{option.method}</small>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <label className="checkout-field">
        <span>Email для чека и уведомления о платеже</span>
        <input
          name="email"
          type="email"
          required
          maxLength={160}
          autoComplete="email"
          placeholder="name@company.ru"
        />
      </label>

      {isBusiness && (
        <div className="buyer-fields">
          <label className="checkout-field">
            <span>
              Наименование организации или ИП <b>*</b>
            </span>
            <input
              name="buyerName"
              required
              maxLength={200}
              autoComplete="organization"
              placeholder="ООО «Монтаж-ПожСервис»"
            />
          </label>
          <label className="checkout-field">
            <span>
              ИНН <b>*</b>
            </span>
            <input
              name="buyerInn"
              required
              inputMode="numeric"
              pattern="\d{10}|\d{12}"
              maxLength={12}
              className="mono-input"
              placeholder="10 цифр для организации, 12 для ИП"
            />
            <span className="field-hint">
              Реквизиты попадут в чек НПД. Проверьте их до оплаты.
            </span>
          </label>
          <p className="buyer-note">
            Оплата картой доступна только физическим лицам. На следующем шаге покажем номер
            заказа и реквизиты для перевода.
          </p>
        </div>
      )}

      <button className="button button-primary full" type="submit">
        {isBusiness ? "Перейти к оплате по счёту" : individualLabel}{" "}
        <span aria-hidden="true">→</span>
      </button>
    </>
  );
}
