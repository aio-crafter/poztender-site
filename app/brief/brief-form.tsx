"use client";

import { FormEvent, useState } from "react";

interface BriefFormProps {
  invoiceId?: string;
  outSum?: string;
  accessExpires?: string;
  accessToken?: string;
}

export function BriefForm({
  invoiceId = "",
  outSum = "",
  accessExpires = "",
  accessToken = "",
}: BriefFormProps) {
  const [replyChannel, setReplyChannel] = useState<"telegram" | "email">("telegram");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    setMessage("");

    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload: Record<string, FormDataEntryValue | boolean> = {
      ...Object.fromEntries(formData.entries()),
      consent: formData.get("consent") === "on",
    };

    try {
      const response = await fetch("/api/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        setStatus("error");
        setMessage(result.error || "Не удалось отправить анкету.");
        return;
      }

      setStatus("success");
      setMessage("Анкета доставлена. Мы проверим её и ответим выбранным способом.");
      form.reset();
      setReplyChannel("telegram");
    } catch {
      setStatus("error");
      setMessage("Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.");
    }
  }

  if (status === "success") {
    return (
      <div className="brief-success" role="status">
        <span className="result-mark success" aria-hidden="true">✓</span>
        <h2>Всё получено</h2>
        <p>{message}</p>
        <a className="button button-secondary" href="/">Вернуться на главную</a>
      </div>
    );
  }

  return (
    <form className="brief-form" onSubmit={submit} noValidate={false}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="outSum" value={outSum} />
      <input type="hidden" name="accessExpires" value={accessExpires} />
      <input type="hidden" name="accessToken" value={accessToken} />
      <div className="honeypot" aria-hidden="true">
        <label>Сайт<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>

      <fieldset>
        <legend><span>01</span> Компания и контакт</legend>
        <div className="form-grid two-columns">
          <label>
            Компания или ИП <b>*</b>
            <input name="company" maxLength={160} required autoComplete="organization" placeholder="ООО «Монтаж-ПожСервис»" />
          </label>
          <label>
            ИНН <b>*</b>
            <input name="inn" inputMode="numeric" pattern="(?:\d{10}|\d{12})" maxLength={12} required placeholder="10 или 12 цифр" />
          </label>
          <label>
            Контактное лицо <b>*</b>
            <input name="contactName" maxLength={100} required autoComplete="name" placeholder="Имя и должность" />
          </label>
          <label>
            Рабочий email <b>*</b>
            <input name="email" type="email" maxLength={160} required autoComplete="email" placeholder="name@company.ru" />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend><span>02</span> Куда прислать ответ</legend>
        <div className="channel-choice">
          <label className={replyChannel === "telegram" ? "selected" : ""}>
            <input
              type="radio"
              name="replyChannel"
              value="telegram"
              checked={replyChannel === "telegram"}
              onChange={() => setReplyChannel("telegram")}
            />
            <strong>Telegram</strong>
            <small>Быстрее для уведомлений и уточнений</small>
          </label>
          <label className={replyChannel === "email" ? "selected" : ""}>
            <input
              type="radio"
              name="replyChannel"
              value="email"
              checked={replyChannel === "email"}
              onChange={() => setReplyChannel("email")}
            />
            <strong>Email</strong>
            <small>Удобнее для документов и длинных ответов</small>
          </label>
        </div>
        <label className="telegram-field">
          Telegram {replyChannel === "telegram" && <b>*</b>}
          <input
            name="telegram"
            maxLength={33}
            required={replyChannel === "telegram"}
            placeholder="@username"
            autoComplete="off"
          />
        </label>
      </fieldset>

      <fieldset>
        <legend><span>03</span> Профиль тендерного радара</legend>
        <div className="form-grid">
          <label>
            Регионы поиска <b>*</b>
            <textarea name="regions" maxLength={500} required rows={3} placeholder="Например: Самарская область и соседние регионы" />
          </label>
          <label>
            Виды работ и ключевые направления <b>*</b>
            <textarea name="workTypes" maxLength={1200} required rows={4} placeholder="Монтаж и обслуживание АПС, СОУЭ, пусконаладка…" />
          </label>
          <div className="form-grid two-columns">
            <label>
              Диапазон НМЦК
              <input name="budget" maxLength={300} placeholder="Например: от 300 тыс. до 5 млн ₽" />
            </label>
            <label>
              Лицензии и допуски
              <input name="licenses" maxLength={800} placeholder="Какие виды лицензии МЧС доступны" />
            </label>
          </div>
          <label>
            Стоп-факторы и важные ограничения
            <textarea name="exclusions" maxLength={1200} rows={4} placeholder="Срок подачи, обеспечение, опыт, удалённость, конкретные работы…" />
          </label>
        </div>
      </fieldset>

      <label className="consent-check">
        <input name="consent" type="checkbox" required />
        <span>Я согласен(на) на обработку данных для настройки радара и ознакомился(лась) с <a href="/privacy" target="_blank">политикой данных</a>. Не отправляю пароли, данные карт и документы с избыточными персональными данными.</span>
      </label>

      {status === "error" && (
        <div className="form-error" role="alert">
          <strong>Анкета не отправлена</strong>
          <span>{message}</span>
          <span>Резервный контакт: <a href="https://t.me/kruger79" target="_blank" rel="noreferrer">@kruger79</a> или <a href="mailto:beastsahsa@yandex.ru">email</a>.</span>
        </div>
      )}

      <button className="button button-primary brief-submit" type="submit" disabled={status === "sending"}>
        {status === "sending" ? "Отправляем…" : "Отправить анкету"}
        <span aria-hidden="true">→</span>
      </button>
      <p className="form-note">Анкета сразу попадёт ответственному за запуск. Обычно уточнения приходят выбранным способом.</p>
    </form>
  );
}
