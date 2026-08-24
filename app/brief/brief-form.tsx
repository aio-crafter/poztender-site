"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

const DRAFT_KEY = "poztender-brief-draft";
const DRAFT_TEXT_FIELDS = [
  "company",
  "inn",
  "contactName",
  "email",
  "telegram",
  "regions",
  "workTypes",
  "budget",
  "licenses",
  "exclusions",
] as const;

const COUNTED_FIELDS: Record<string, number> = {
  regions: 500,
  workTypes: 1200,
  exclusions: 1200,
};

// `namedItem` can also return a RadioNodeList or a plain Element, neither of
// which carries `.value`. Narrowing by instance keeps the value access honest
// instead of asserting a type the DOM does not guarantee.
function valueField(form: HTMLFormElement, name: string) {
  const element = form.elements.namedItem(name);
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? element
    : null;
}

// Paid access is proved by the HttpOnly checkout cookie the browser sends
// automatically, so the form no longer carries any access parameters.
export function BriefForm() {
  const [replyChannel, setReplyChannel] = useState<"telegram" | "email">("telegram");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [lengths, setLengths] = useState<Record<string, number>>({});
  const [draftRestored, setDraftRestored] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;

    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as Record<string, string>;
      let restored = false;

      for (const field of DRAFT_TEXT_FIELDS) {
        const value = draft[field];
        if (!value) continue;
        const element = valueField(form, field);
        if (element) {
          element.value = value;
          restored = true;
        }
      }
      if (draft.replyChannel === "telegram" || draft.replyChannel === "email") {
        setReplyChannel(draft.replyChannel);
        restored = true;
      }

      if (restored) {
        setDraftRestored(true);
        const counters: Record<string, number> = {};
        for (const field of Object.keys(COUNTED_FIELDS)) {
          const element = valueField(form, field);
          if (element) counters[field] = element.value.length;
        }
        setLengths(counters);
      }
    } catch {
      // corrupted or unavailable draft — ignore
    }
  }, []);

  function saveDraft() {
    const form = formRef.current;
    if (!form) return;
    try {
      const formData = new FormData(form);
      const draft: Record<string, string> = { replyChannel };
      for (const field of DRAFT_TEXT_FIELDS) {
        const value = formData.get(field);
        if (typeof value === "string" && value) draft[field] = value;
      }
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // storage unavailable — skip autosave silently
    }
  }

  function handleFormChange() {
    const form = formRef.current;
    if (!form) return;

    const counters: Record<string, number> = {};
    for (const field of Object.keys(COUNTED_FIELDS)) {
      const element = valueField(form, field);
      if (element) counters[field] = element.value.length;
    }
    setLengths((current) => ({ ...current, ...counters }));
    saveDraft();
  }

  function clearDraft() {
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // ignore
    }
    formRef.current?.reset();
    setReplyChannel("telegram");
    setLengths({});
    setDraftRestored(false);
  }

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
      try {
        window.localStorage.removeItem(DRAFT_KEY);
      } catch {
        // ignore
      }
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
    <form className="brief-form" ref={formRef} onSubmit={submit} onChange={handleFormChange} noValidate={false}>
      <div className="honeypot" aria-hidden="true">
        <label>Сайт<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>

      {draftRestored && (
        <div className="draft-note">
          <span>Восстановили черновик анкеты из прошлого визита.</span>
          <button type="button" onClick={clearDraft}>Очистить</button>
        </div>
      )}

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
            <small>Ответим и уточним детали в Telegram</small>
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
        {replyChannel === "telegram" ? (
          <label className="telegram-field">
            Telegram <b>*</b>
            <input
              name="telegram"
              maxLength={40}
              required
              placeholder="@username или +7 999 123-45-67"
              autoComplete="off"
            />
            <span className="field-hint">Укажите @username или номер телефона, привязанный к Telegram.</span>
          </label>
        ) : (
          <p className="field-hint">Ответ придёт на email, указанный выше в контактных данных.</p>
        )}
      </fieldset>

      <fieldset>
        <legend><span>03</span> Профиль тендерного радара</legend>
        <div className="form-grid">
          <label>
            Регионы поиска <b>*</b>
            <textarea name="regions" maxLength={500} required rows={3} placeholder="Например: Самарская область и соседние регионы" />
            <span className={`char-counter${(lengths.regions ?? 0) >= 500 ? " limit" : ""}`}>{lengths.regions ?? 0} / 500</span>
          </label>
          <label>
            Виды работ и ключевые направления <b>*</b>
            <textarea name="workTypes" maxLength={1200} required rows={4} placeholder="Монтаж и обслуживание АПС, СОУЭ, пусконаладка…" />
            <span className={`char-counter${(lengths.workTypes ?? 0) >= 1200 ? " limit" : ""}`}>{lengths.workTypes ?? 0} / 1200</span>
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
            <span className={`char-counter${(lengths.exclusions ?? 0) >= 1200 ? " limit" : ""}`}>{lengths.exclusions ?? 0} / 1200</span>
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
      <p className="form-note">Анкета сразу попадёт ответственному за запуск. Обычно уточнения приходят выбранным способом. Черновик сохраняется у вас в браузере, пока вы не отправите анкету.</p>
    </form>
  );
}
