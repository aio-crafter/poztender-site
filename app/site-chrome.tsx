export function Header() {
  return (
    <header className="site-header">
      <div className="shell nav-wrap">
        <a className="brand" href="/" aria-label="ПожТендер — главная">
          <span className="brand-mark" aria-hidden="true">ПТ</span>
          <span>ПожТендер</span>
        </a>
        <nav aria-label="Основная навигация">
          <a href="/#example">Пример</a>
          <a href="/#process">Как работает</a>
          <a href="/#price">Цена</a>
          <a href="/payment">Оплата и анкета</a>
        </nav>
        <div className="header-actions">
          <a className="header-offer" href="/offer">Оферта</a>
          <a className="header-cta" href="/payment">Оплатить <span aria-hidden="true">→</span></a>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="shell footer-grid">
        <div>
          <a className="brand brand-footer" href="/">
            <span className="brand-mark" aria-hidden="true">ПТ</span>
            <span>ПожТендер</span>
          </a>
          <p>Автономный радар закупок по АПС и СОУЭ.</p>
        </div>
        <div className="footer-details">
          <span>Исполнитель: Сурков Александр Игоревич</span>
          <span>ИНН 631608072510 · плательщик НПД</span>
          <span>Самара, Самарская область</span>
          <span>Онлайн-оплата и автоматический чек НПД через Robokassa</span>
        </div>
        <div className="footer-links">
          <a href="mailto:beastsahsa@yandex.ru">beastsahsa@yandex.ru</a>
          <a href="https://t.me/kruger79" target="_blank" rel="noreferrer">Telegram: @kruger79</a>
          <a href="/offer">Публичная оферта</a>
          <a href="/privacy">Политика обработки данных</a>
          <a href="/payment">Оплата и анкета</a>
        </div>
      </div>
      <div className="shell footer-bottom">
        <span>© 2026 ПожТендер</span>
        <span>Информационно-аналитический сервис</span>
      </div>
    </footer>
  );
}
