import { Footer, Header } from "./site-chrome";

const mailUrl =
  "mailto:beastsahsa@yandex.ru?subject=%D0%9F%D0%BE%D0%B6%D0%A2%D0%B5%D0%BD%D0%B4%D0%B5%D1%80%20%E2%80%94%20%D1%81%D1%87%D1%91%D1%82%20%D0%B4%D0%BB%D1%8F%20%D0%AE%D0%9B%2F%D0%98%D0%9F&body=%D0%9D%D0%B0%D0%B7%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5%20%D0%BA%D0%BE%D0%BC%D0%BF%D0%B0%D0%BD%D0%B8%D0%B8%3A%0A%D0%98%D0%9D%D0%9D%3A%0A%D0%A0%D0%B5%D0%B3%D0%B8%D0%BE%D0%BD%D1%8B%20%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D1%8B%3A%0A%D0%9A%D0%BE%D0%BD%D1%82%D0%B0%D0%BA%D1%82%3A";

const verdicts = [
  {
    code: "01",
    tone: "go",
    title: "Предварительно подходит",
    text: "Условия совпали с профилем. Видно, почему закупку стоит разобрать первой.",
  },
  {
    code: "02",
    tone: "review",
    title: "Нужна проверка",
    text: "Данных не хватает или источники расходятся. Радар не делает вид, что всё ясно.",
  },
  {
    code: "03",
    tone: "stop",
    title: "Исключено",
    text: "Есть стоп-фактор: лицензия, география, срок, обеспечение или другой ваш лимит.",
  },
];

export default function Home() {
  return (
    <main>
      <Header />

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Радар закупок · АПС / СОУЭ · 44-ФЗ / 223-ФЗ</p>
          <h1>
            Тендеры по пожарной безопасности.
            <span> Сразу видно: идти или нет.</span>
          </h1>
          <p className="hero-lead">
            ПожТендер отсеивает неподходящие закупки и объясняет решение по каждой:
            лицензия, регион, сумма, сроки, обеспечение и полнота документов.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="/payment">
              Оплатить 4 900 ₽ онлайн
              <span aria-hidden="true">→</span>
            </a>
            <a className="button button-secondary" href="#example">
              Посмотреть пример
              <span aria-hidden="true">↓</span>
            </a>
          </div>
          <p className="microcopy">
            Один профиль · 7 календарных дней · без автопродления. Старт после оплаты и короткой анкеты.
          </p>
        </div>

        <div className="hero-panel" aria-label="Сводка радара">
          <div className="panel-topline">
            <span>РАДАР / СЕГОДНЯ</span>
            <span className="live-dot">ОБНОВЛЕНО</span>
          </div>
          <div className="radar-score">
            <span className="score-number">07</span>
            <span className="score-label">закупок<br />в разборе</span>
          </div>
          <div className="radar-lines">
            <div><span className="status-mark go" />Предварительно подходит <b>2</b></div>
            <div><span className="status-mark review" />Нужна проверка <b>3</b></div>
            <div><span className="status-mark stop" />Исключено <b>2</b></div>
          </div>
          <p className="panel-note">Цифры демонстрационные. Ваш радар строится по профилю компании.</p>
        </div>
      </section>

      <section className="signal-strip" aria-label="Что проверяет радар">
        <div className="shell signal-track">
          <span>ЛИЦЕНЗИЯ МЧС</span><i />
          <span>РЕГИОН</span><i />
          <span>НМЦК</span><i />
          <span>СРОК ПОДАЧИ</span><i />
          <span>ОБЕСПЕЧЕНИЕ</span><i />
          <span>ДОКАЗАТЕЛЬСТВА</span>
        </div>
      </section>

      <section className="section shell" id="verdicts">
        <div className="section-heading split-heading">
          <div>
            <p className="eyebrow">Не список ссылок, а решение</p>
            <h2>Три честных статуса</h2>
          </div>
          <p>
            Если данных недостаточно, закупка не попадёт в «подходит». Она останется на ручной проверке — вместе с причиной.
          </p>
        </div>
        <div className="verdict-grid">
          {verdicts.map((item) => (
            <article className={`verdict-card ${item.tone}`} key={item.code}>
              <span className="verdict-code">{item.code}</span>
              <span className={`status-label ${item.tone}`}>{item.title}</span>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section section-dark" id="example">
        <div className="shell">
          <div className="section-heading split-heading light">
            <div>
              <p className="eyebrow">Что приходит вам</p>
              <h2>Один экран вместо часа поиска</h2>
            </div>
            <p>Ниже — вымышленная карточка, показывающая формат результата. Она не является реальной закупкой.</p>
          </div>

          <article className="tender-card">
            <div className="demo-ribbon">Демонстрационный пример</div>
            <div className="tender-head">
              <div>
                <span className="status-label go">Предварительно подходит</span>
                <p className="tender-kicker">44-ФЗ · Электронный аукцион · Самарская область</p>
                <h3>Монтаж автоматической пожарной сигнализации и системы оповещения</h3>
              </div>
              <div className="price-block">
                <span>НМЦК</span>
                <strong>2,40 млн ₽</strong>
              </div>
            </div>

            <div className="tender-meta">
              <div><span>Заказчик</span><strong>ГБУ «Демонстрационный центр»</strong></div>
              <div><span>Подать до</span><strong>20.08.2026 · 09:00</strong></div>
              <div><span>Проверено</span><strong>12.08.2026 · 15:40</strong></div>
            </div>

            <div className="tender-analysis">
              <div className="why-go">
                <p className="analysis-title">Почему статус положительный</p>
                <ul className="check-list">
                  <li><span>✓</span>Регион входит в рабочую географию</li>
                  <li><span>✓</span>НМЦК внутри заданного диапазона</li>
                  <li><span>✓</span>Работы соответствуют выбранным видам лицензии МЧС</li>
                  <li><span>✓</span>До окончания подачи больше 5 рабочих дней</li>
                </ul>
              </div>
              <div className="risk-box">
                <p className="analysis-title">Проверить до решения</p>
                <ul>
                  <li>Требования к опыту по 44-ФЗ</li>
                  <li>Смету и совместимость оборудования</li>
                  <li>Обеспечение контракта: 10%</li>
                </ul>
                <span className="source-note">Первоисточник: ссылка ЕИС в рабочем дайджесте</span>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section className="section shell" id="process">
        <div className="section-heading">
          <p className="eyebrow">Запуск без внедрения</p>
          <h2>Три шага до рабочего радара</h2>
        </div>
        <ol className="process-grid">
          <li>
            <span>01</span>
            <h3>Фиксируем профиль</h3>
            <p>Регионы, виды работ, допуски, диапазон суммы, лимиты обеспечения и стоп-факторы.</p>
          </li>
          <li>
            <span>02</span>
            <h3>Калибруем 7 дней</h3>
            <p>Вы получаете отбор и помечаете ошибки. Правила становятся точнее под вашу компанию.</p>
          </li>
          <li>
            <span>03</span>
            <h3>Решаете, продолжать ли</h3>
            <p>После пилота — только явное подтверждение подписки. Никакого автосписания.</p>
          </li>
        </ol>
      </section>

      <section className="section shell" id="price">
        <div className="pricing-wrap">
          <div className="pricing-copy">
            <p className="eyebrow">Первый запуск</p>
            <h2>Проверить на своих критериях</h2>
            <p>
              Пилот показывает не обещания, а реальные попадания и причины решений. Даже если совпадений не будет, вы увидите обработанные закупки и правила исключения.
            </p>
            <div className="limits-note">
              <strong>Границы сервиса</strong>
              <span>Не подаём заявки, не работаем с ЭП и кабинетами ЭТП, не даём юридическое заключение и не гарантируем победу.</span>
            </div>
          </div>
          <div className="price-card">
            <span className="price-name">Калибровка</span>
            <div className="price">4 900 <small>₽</small></div>
            <span className="price-period">за 7 календарных дней</span>
            <ul>
              <li>Один профиль компании</li>
              <li>Закупки по АПС и СОУЭ</li>
              <li>Объяснение каждого статуса</li>
              <li>Доставка в Telegram или email</li>
              <li>Чек самозанятого</li>
            </ul>
            <a className="button button-primary full" href="/payment">
              Оплатить онлайн
              <span aria-hidden="true">→</span>
            </a>
            <p>Карта или СБП на защищённой странице. Чек НПД приходит автоматически. Далее — 7 900 ₽/мес., но только после вашего подтверждения.</p>
          </div>
        </div>
      </section>

      <section className="section faq-section shell" id="faq">
        <div className="section-heading">
          <p className="eyebrow">Коротко о важном</p>
          <h2>Вопросы перед стартом</h2>
        </div>
        <div className="faq-grid">
          <article><h3>Нужно давать доступ к ЭТП?</h3><p>Нет. Мы не просим логины, пароли, электронную подпись или банковские данные.</p></article>
          <article><h3>Что, если подходящих закупок не будет?</h3><p>Такое возможно. Вы получите обработанные позиции и причины исключения, но мы не обещаем заданное число совпадений.</p></article>
          <article><h3>Радар решает, участвовать ли?</h3><p>Он даёт предварительную аналитику. Финальное решение и проверка документации всегда остаются за вашей компанией.</p></article>
          <article><h3>Как проходит оплата?</h3><p>Можно оплатить картой или СБП онлайн прямо на сайте — чек НПД придёт автоматически. Для оплаты со счёта организации готовим индивидуальный счёт-оферту: после оплаты от ООО или ИП отправляем чек НПД и начинаем калибровку.</p></article>
        </div>
      </section>

      <section className="closing">
        <div className="shell closing-inner">
          <div>
            <p className="eyebrow">Перестать листать всё подряд</p>
            <h2>Покажите, какие закупки вам нужны.</h2>
          </div>
          <div className="closing-actions">
            <a className="button button-primary" href="/payment">Оплатить онлайн <span aria-hidden="true">→</span></a>
            <a className="text-link" href={mailUrl}>или запросить счёт для ЮЛ/ИП →</a>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
