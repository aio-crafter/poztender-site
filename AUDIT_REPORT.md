# Аудит платёжного контура Robokassa и production-инфраструктуры

- Репозиторий: `C:\Users\a_surkov\Projects\poztender-site`
- Remote: `https://github.com/aio-crafter/poztender-site.git`
- Ветка: `audit/robokassa-production`
- Дата: 2026-08-19
- Реальные платежи не выполнялись, настройки Robokassa не менялись, деплой не выполнялся, production ENV не менялись.

Итерация 1 — аудит (найдены CRITICAL-1 и CRITICAL-2).
Итерация 2 — определение production и проектирование.
Итерация 3 — **реализация persistent payment architecture** (этот документ).

---

## 1. Production architecture

Установлено измерением, а не предположением.

| Проверка | Результат | Вывод |
|---|---|---|
| NS | `ns1/ns2.timeweb.ru`, `ns3/ns4.timeweb.org` | Домен на Timeweb |
| A (apex и www) | `72.56.252.59`, без CNAME | Прямой хост, не проксируется |
| MX / SPF | `mx1/mx2.timeweb.ru`, `include:_spf.timeweb.ru` | Timeweb |
| HTTP-заголовки | `Via: 1.1 Caddy`, `Alt-Svc: h3` | Caddy-ingress Timeweb App Platform |
| Заголовки приложения | `Vary: … X-Vinext-Rsc-Render-Mode` | Отвечает именно этот код |
| **`GET /health`** | **`200 ok`** | **Решающее: маршрут есть только в `server.mjs`** |
| TLS | Let's Encrypt, `CN=poztender.ru` | Автовыпуск Caddy |
| Cloudflare-маркеры | нет `cf-ray`, нет `server: cloudflare` | Workers не используются |
| `dist/server/wrangler.json` | `"d1_databases": []` | D1 недоступен |
| `IsTest` в боевой форме | `1` | Production сейчас в **тестовом режиме** |

**Итог:** Timeweb Cloud App Platform → Docker → Node 22 → `server.mjs`. API routes и callback Robokassa исполняются в этом же процессе.

База данных — **Neon PostgreSQL**, внешний managed-сервис: приложение в Timeweb, база в Neon. Persistent storage до этой итерации отсутствовал полностью.

---

## 2. Новая архитектура payment flow

```
Браузер                    Приложение (Node)                PostgreSQL         Robokassa
   │                              │                              │                 │
   ├─ POST /api/payment/start ───►│                              │                 │
   │   plan + email               │ цена ← productForPlan(plan)  │                 │
   │                              │ InvId ← CSPRNG               │                 │
   │                              ├─ INSERT order(pending) ─────►│                 │
   │◄── Set-Cookie (HttpOnly) ────┤   expected_amount, session_hash                │
   │◄── autosubmit form ──────────┤                              │                 │
   ├──────────── подписанный запрос на оплату ──────────────────────────────────► │
   │                                                                               │
   │                              │◄──── POST ResultURL ─────────────────────────┤
   │                              │ 1 подпись (Password#2)       │                 │
   │                              │ 2 поиск по InvId ───────────►│                 │
   │                              │ 3 OutSum == expected_amount  │                 │
   │                              │ ┌── TRANSACTION ────────────►│                 │
   │                              │ │ UPDATE … WHERE status='pending'              │
   │                              │ │ INSERT access_grant        │                 │
   │                              │ └── COMMIT ─────────────────►│                 │
   │                              ├──────── OK{InvId} ───────────────────────────► │
   │                              │   (только после commit)      │                 │
   │◄─ редирект на SuccessURL ─────────────────────────────────────────────────────┤
   ├─ GET /payment/success ──────►│ cookie → order ─────────────►│                 │
   │   (ничего не создаёт)        │ status? paid → доступ        │                 │
   │◄── «Платёж подтверждён» ─────┤        pending → «обрабатывается»              │
   │                              │                              │                 │
   ├─ GET /brief ────────────────►│ cookie → order → grant ─────►│                 │
```

Ключевое отличие: **единственный путь к доступу проходит через ResultURL и транзакцию БД.** SuccessURL полностью read-only и игнорирует свои query-параметры.

---

## 3. DB schema

```sql
CREATE TABLE "orders" (
  "id"              serial PRIMARY KEY NOT NULL,
  "invoice_id"      bigint NOT NULL,
  "plan"            text NOT NULL,
  "expected_amount" numeric(12,2) NOT NULL,
  "email"           text NOT NULL,
  "status"          text DEFAULT 'pending' NOT NULL,
  "session_hash"    text NOT NULL,
  "created_at"      timestamptz DEFAULT now() NOT NULL,
  "paid_at"         timestamptz,
  CONSTRAINT "orders_invoice_id_unique" UNIQUE("invoice_id")
);

CREATE TABLE "access_grants" (
  "id"          serial PRIMARY KEY NOT NULL,
  "order_id"    integer NOT NULL,
  "valid_from"  timestamptz NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "used_at"     timestamptz,
  "revoked_at"  timestamptz,
  CONSTRAINT "access_grants_order_id_unique" UNIQUE("order_id")
);

ALTER TABLE "access_grants"
  ADD CONSTRAINT "access_grants_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id");

CREATE INDEX "orders_session_hash_idx" ON "orders" USING btree ("session_hash");
```

Два ограничения несут всю гарантию:

- **`UNIQUE(orders.invoice_id)`** — якорь идемпотентности платежа.
- **`UNIQUE(access_grants.order_id)`** — «один оплаченный заказ = максимум один доступ» становится свойством данных, а не удачного порядка выполнения кода.

### Почему нет таблицы `payments`

По требованию п. 11 я сначала проверил, есть ли у callback стабильный идентификатор операции. В ResultURL Robokassa присылает `OutSum`, `InvId`, `SignatureValue`, `Fee`, `EMail`, `PaymentMethod`, `IncCurrLabel`, `Shp_*` — **собственного transaction id там нет**, он доступен только через отдельный API запроса состояния. Хранить было бы нечего, кроме дубля `InvId`, поэтому отдельная таблица не добавлена. Аудит-след обеспечивают `orders.paid_at` и строки лога `[payment] result callback …`.

### Модель доступа

- Секрет checkout-сессии: 32 байта из CSPRNG, base64url. **В БД лежит только SHA-256** (`session_hash`), plaintext живёт исключительно в HttpOnly-cookie.
- Cookie: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7 дней`.
- Cookie доказывает **только** связь браузера с заказом. Доказательство оплаты — `orders.status = 'paid'`.
- Окно доступа отсчитывается от `paid_at`, а не от момента открытия страницы, поэтому его нельзя продлить визитами.
- Секрет сессии **переиспользуется** при повторном checkout — см. security retest.

---

## 4. Migration

Файл: `drizzle/0000_conscious_captain_cross.sql` (сгенерирован `drizzle-kit generate`).
К production БД **не применялся** — БД ещё не создана.

Порядок применения:

```bash
# DATABASE_URL берётся из окружения, в файлы репозитория не пишется.
# Для миграций — direct-строка Neon (без суффикса -pooler).
export DATABASE_URL='postgresql://…direct-host…/DBNAME?sslmode=verify-full'
npm run db:migrate
```

Данных для переноса нет: платежи никогда не сохранялись.

---

## 5. Изменённые файлы

**Новые**

| Файл | Назначение |
|---|---|
| `lib/orders.ts` | Репозиторий заказов: создание, транзакция подтверждения, проверка доступа |
| `lib/payment-session.ts` | Секрет сессии, хеширование, cookie |
| `lib/buyer.ts` | Тип покупателя, валидация ИНН по контрольной сумме |
| `app/payment/checkout-fields.tsx` | Поля чекаута с выбором типа покупателя |
| `drizzle/0001_previous_speed.sql` | Реквизиты покупателя + CHECK-ограничение |
| `drizzle/0000_conscious_captain_cross.sql` + `meta/` | Миграция |
| `tests/payment.test.mjs` | 33 теста платёжного контура |
| `tests/payment-db-down.test.mjs` | 3 теста поведения при недоступной БД |
| `tests/database-tls.test.mjs` | 4 теста строгости TLS к базе |
| `tests/helpers/postgres.mjs` | Запуск PGlite поверх TCP |

**Изменённые**

| Файл | Что |
|---|---|
| `db/schema.ts` | Пустой файл → две таблицы |
| `db/index.ts` | `cloudflare:workers`/D1 → пул node-postgres; TLS-guard, `ssl`-объект и `DATABASE_SSL` удалены (§13) |
| `drizzle.config.ts` | `sqlite` → `postgresql`, URL из окружения |
| `app/api/payment/start/route.ts` | Создание заказа, cookie, rate limit, POST |
| `app/api/payment/result/route.ts` | Authoritative: поиск, сверка суммы, транзакция, grant, 5xx при отказе |
| `app/payment/success/page.tsx` | Полностью read-only, состояние из БД |
| `app/brief/page.tsx` | Доступ по cookie + grant |
| `app/brief/brief-form.tsx` | Убраны поля access-токенов; типобезопасный доступ к DOM |
| `app/api/intake/route.ts` | Cookie + grant, `used_at` вместо Map в памяти |
| `app/payment/page.tsx`, `app/renew/page.tsx` | POST-форма, сообщения об ошибках |
| `lib/robokassa.ts` | Удалены `createIntakeAccessToken` / `isIntakeAccessValid` |
| `lib/intake.ts` | `invoiceId` больше не принимается от клиента |
| `worker/index.ts` | Убраны типы D1/Fetcher |
| `package.json` | `pg`; скрипты `typecheck`, `db:migrate` |
| `tsconfig.json` | Исключены `dist` и `examples` |
| `.env.example` | `DATABASE_URL` (Neon, `sslmode=verify-full`), `DATABASE_POOL_MAX` |
| `DEPLOY_TIMEWEB.md` | Раздел про базу данных в Neon и применение миграции |

---

## 6. Как устранены CRITICAL-1 и CRITICAL-2

**CRITICAL-1 — replay SuccessURL.** Устранён структурно, а не проверкой. SuccessURL больше не читает `InvId`, `OutSum` и `SignatureValue` вообще: он резолвит cookie в заказ и показывает то, что уже записано на сервере. Токенов он не выпускает. Повторное открытие ничего не создаёт и не продлевает — это закреплено `UNIQUE(access_grants.order_id)` и тестом, который открывает страницу пять раз и сверяет `valid_until`.

**CRITICAL-2 — ResultURL ничего не делал.** Теперь это единственный authoritative путь: подпись → поиск заказа по `InvId` → сверка `OutSum` с `expected_amount` → транзакция `pending → paid` + создание grant → commit → и только потом `OK{InvId}`. При любом отказе БД возвращается 500, чтобы Robokassa повторила доставку, а не сочла платёж принятым.

**Идемпотентность и гонки.** Конкурентность решает условный UPDATE, а не предшествующий SELECT: два одновременных callback-а читают `pending`, второй UPDATE блокируется на строке первого, после commit перепроверяет `status = 'pending'` и не находит совпадений. Ровно один вызов получает строку и создаёт grant. Проверено тестом с тремя одновременными callback-ами.

---

## 7. Security retest

Повторная атака на собственную систему после реализации.

| Вектор | Результат |
|---|---|
| Подмена цены (`OutSum`, `price`, `amount`, `expectedAmount`, `tariff`) | ✅ Игнорируется; цена только из `plan` на сервере |
| Подмена тарифа (`plan=free`, `plan=Subscription`) | ✅ Откат к пилоту |
| Поддельный SuccessURL с корректной подписью Password#1 | ✅ Параметры не читаются, доступа нет |
| Поддельный ResultURL | ✅ 403 |
| ResultURL, подписанный Password#1 | ✅ 403 |
| Подпись от другого заказа | ✅ 403 |
| Неизвестный InvId | ✅ 404, `OK` не возвращается |
| Несовпадение суммы | ✅ 400, заказ остаётся `pending` |
| Повторный callback (×4) | ✅ 200 `OK`, `paid_at` не меняется, второго grant нет |
| Три одновременных callback-а | ✅ Один платёж, один grant |
| Отказ БД | ✅ 500, `OK` не возвращается |
| Подделка cookie (усечение, инверсия символа, лишние символы) | ✅ Доступа нет |
| Отсутствие cookie | ✅ Доступа нет |
| Истёкший / отозванный / уже использованный grant | ✅ Анкета закрыта |
| Старые URL-токены прежней схемы | ✅ Инертны |
| Перебор заказов | ✅ InvId случайный (52 бита); SuccessURL не принимает идентификатор; поиск требует 43-символьный секрет |
| Доступ без оплаты | ✅ Требуется `status = 'paid'` |

### Найдено и исправлено в ходе retest

**S-1 (High) — потеря оплаченного доступа при повторном checkout.**
Изначально я генерировал новый секрет на каждый вызов `/api/payment/start`. Клиент, который нажал «Оплатить», вернулся назад и нажал снова, получал новую cookie; заказ из первой попытки становился сиротой. Если затем он оплачивал **первую** вкладку Robokassa, callback помечал первый заказ оплаченным, а браузер держал cookie от второго — и человек навсегда видел «Платёж обрабатывается», уже заплатив. Исправлено: секрет сессии переиспользуется, а поиск предпочитает оплаченный заказ. Покрыто тестом.

**S-2 (Medium) — новый вектор наполнения таблицы заказов.**
Раньше `/api/payment/start` был stateless и просто рисовал форму. Теперь он пишет строку, то есть без ограничения любой мог наполнять `orders`. Добавлен лимит 20 попыток / 10 минут на адрес. Ограничение в памяти — сбрасывается при рестарте, это первый барьер, а не гарантия.

---

## 8. Результаты проверок

| Проверка | Команда | Результат |
|---|---|---|
| Production build | `npm run build` | ✅ exit 0 |
| Tests | `node --test tests/*.test.mjs` | ✅ **57 / 57** |
| Typecheck | `npm run typecheck` | ✅ exit 0 (было 9 ошибок) |
| Lint | `npm run lint` | ⚠️ 1 legacy-ошибка |
| Runtime без `node_modules` | ручной прогон | ✅ см. ниже |
| Docker build | — | ❌ **не выполнен: Docker в этой среде отсутствует** |

### Docker

Docker и любой контейнерный рантайм в среде недоступны (`docker`, `podman` не установлены), поэтому `docker build` **не запускался** — это остаётся непроверенным шагом.

Однако главный риск Docker-сборки проверен напрямую. Runtime-стадия `Dockerfile` копирует только `dist` и `server.mjs`, **без `node_modules`**, поэтому вопрос был один: работает ли вшитый в бандл `pg`. Я воспроизвёл это окружение — скопировал только эти два артефакта в чистый каталог и запустил `node server.mjs`:

```
health            ok
homepage          status=200
brief (no cookie) status=200
result (db down)  status=500  body=Could not record payment
log:              [payment] confirmPayment threw connect ECONNREFUSED 127.0.0.1:1
```

`ECONNREFUSED` доказывает, что драйвер загрузился и открыл настоящее TCP-соединение — то есть `pg` полностью инлайнится сборкой (167 КБ в отдельном чанке), а снаружи остаются только Node-builtins (`net`, `tls`, `crypto`, …). **Правка `Dockerfile` не требуется.** Тем не менее `docker build` следует прогнать перед выкатом.

### Тестовая среда

Тесты работают против **настоящего PostgreSQL**: PGlite (PostgreSQL, скомпилированный в WebAssembly) поднимается поверх TCP-сокета, и собранный воркер подключается к нему тем же вшитым драйвером `pg`, что и в production. UNIQUE-ограничения, транзакции и условный UPDATE исполняет реальный PostgreSQL, а не эмуляция.

Ограничение: PGlite обслуживает один backend, поэтому «одновременные» callback-и на уровне СУБД сериализуются. Логика условного UPDATE проверяется по-настоящему, но полноценная проверка блокировок строк требует многоядерного сервера PostgreSQL — это стоит повторить на реальной БД после её создания.

### Оставшаяся lint-ошибка

`app/brief/brief-form.tsx:65` — `react-hooks/set-state-in-effect`. Существовала до аудита. Это восстановление черновика анкеты из `localStorage` при монтировании; исправление означало бы переработку компонента, не связанного с платежами. Ошибка `react-hooks/purity` в `app/payment/success/page.tsx` исчезла — страница переписана и больше не вызывает `Date.now()` при рендере.

---

## 9. Необходимые ENV (только имена)

**База данных:** `DATABASE_URL` *(обязательно)*, `DATABASE_POOL_MAX`

Переменной `DATABASE_SSL` **нет намеренно** — см. §13.

**Платежи:** `ROBOKASSA_MERCHANT_LOGIN`, `ROBOKASSA_PASSWORD_1`, `ROBOKASSA_PASSWORD_2`, `ROBOKASSA_TEST_MODE`, `ROBOKASSA_B2B_RECEIPT_CONFIRMED`

**Инфраструктура:** `PUBLIC_ORIGIN`, `PORT`

**Доставка анкет:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`

**Опционально:** `TELEGRAM_OWNER_USERNAME`, `TELEGRAM_RELAY_URL`, `TELEGRAM_RELAY_SECRET`, `TELEGRAM_RELAY_AUTH_TOKEN`, `YANDEX_SMTP_USER`, `YANDEX_SMTP_PASSWORD`

---

## 10. Что сделать в Neon и Timeweb

Приложение — Timeweb App Platform (Docker/Node), база — **Neon PostgreSQL**
(внешний managed-сервис, не база Timeweb).

**В Neon**

1. Создать проект и базу.
2. Скопировать обе строки подключения: **pooled** (хост с суффиксом `-pooler`) и
   **direct** (без него).
3. В обеих заменить/задать `sslmode=verify-full` (обоснование — §13).

**В Timeweb (переменные приложения)**

4. `DATABASE_URL` — **pooled** строка Neon. Только в панели, не в Git.
5. При необходимости `DATABASE_POOL_MAX` (по умолчанию 5).
6. Проверить, что `ROBOKASSA_TEST_MODE` задана **явно** (сейчас `true`).
7. Проверить `PUBLIC_ORIGIN` и `TELEGRAM_OWNER_CHAT_ID`.

**Миграция** — один раз, с **direct** строкой в окружении:

```bash
export DATABASE_URL='postgresql://…direct-host…/DBNAME?sslmode=verify-full'
npm run db:migrate
```

Бэкапы обеспечивает Neon; проверить настройки хранения в проекте.

## 11. Что сделать в Robokassa

Ничего из этого я не выполнял.

1. Алгоритм расчёта хеша — **SHA-256** (по умолчанию MD5; при несовпадении не пройдёт ни один платёж).
2. Result URL — `https://poztender.ru/api/payment/result`, метод POST.
3. Success URL — `https://poztender.ru/payment/success`, метод GET.
4. Fail URL — `https://poztender.ru/payment/failed`, метод GET.
5. Фискализация «Робочеки СМЗ» + подтверждение доступа в «Мой налог».
6. Запретить покупателю изменять сумму платежа.
7. Уточнить в поддержке допустимость приёма платежей от юрлиц и ИП на НПД и возможность передать реквизиты покупателя в чек.

---

## 12. Оставшиеся риски

| Риск | Уровень | Статус |
|---|---|---|
| `docker build` не проверен (Docker недоступен) | Medium | Прогнать перед выкатом |
| Блокировки строк не проверены на многоядерном PostgreSQL | Medium | Повторить тест на реальной БД |
| Доступ привязан к браузеру: очистка cookie теряет анкету | Medium | Есть ручной путь восстановления; при желании — вход по ссылке на email |
| Rate limit в памяти сбрасывается при рестарте | Low | Принято |
| Чек без реквизитов B2B при обещании в оферте (п. 5.3) | Medium | Требует решения владельца |
| Обещание автоматического чека НПД без проверки фискализации | Medium | Требует решения владельца |
| `examples/d1/` описывает недостижимую здесь технологию | Low | Исключён из typecheck; рекомендую удалить |
| 1 legacy lint-ошибка | Low | Перечислена выше |

Проблем уровня CRITICAL или HIGH не осталось.

---

## 13. TLS к базе: почему единственный источник конфигурации

Проверено по официальной документации node-postgres, исходникам установленных
`pg` 8.16.3 / `pg-connection-string` 2.14.0 и документации Neon, а также
эмпирически на этой сборке.

### Строка подключения перекрывает `ssl`-объект, а не сливается с ним

`pg/lib/connection-parameters.js` делает
`config = Object.assign({}, config, parse(config.connectionString))` —
результат разбора идёт **последним** аргументом. А `pg-connection-string`
создаёт ключ `ssl`, как только в URL есть любой из
`sslmode` / `sslcert` / `sslkey` / `sslrootcert`. Документация node-postgres
формулирует это прямо: если использован любой из этих параметров, «the `ssl`
object is replaced and any additional options provided there will be lost».

Замер на нашей сборке:

| Конфигурация | Итоговый `ssl` |
|---|---|
| `?sslmode=require` + `ssl:{rejectUnauthorized:false}` | `{}` — объект **отброшен** |
| `?sslmode=verify-full` + `ssl:{rejectUnauthorized:false}` | `{}` — объект **отброшен** |
| без ssl-параметров + `ssl:{rejectUnauthorized:false}` | `{rejectUnauthorized:false}` — объект **применён** |
| `?sslmode=disable` + `ssl`-объект | `false` |

Отсюда прямое следствие: прежняя схема с `DATABASE_SSL` была не просто лишней,
а **вредной**. При Neon-строке с `sslmode` она молча игнорировалась, создавая
ложное впечатление управляемости; а при строке без `sslmode` — наоборот,
срабатывала и отключала проверку сертификата. Один и тот же код давал разный
уровень TLS в зависимости от формы URL. Есть и третий скрытый источник —
переменная `PGSSLMODE`, которую `pg` читает, когда `ssl` не задан ни в коде, ни
в строке.

**Решение:** `DATABASE_SSL` удалена, `ssl`-объект в коде не передаётся вовсе,
TLS задаётся только `DATABASE_URL`. `db/index.ts` при первом обращении
валидирует URL и отказывается работать при небезопасной конфигурации.

### Почему `verify-full`, а не `require`

В `pg-connection-string` 2.14.0 два набора семантик. По умолчанию (наш случай —
`pg` не передаёт `useLibpqCompat`) `prefer`, `require`, `verify-ca` и
`verify-full` дают одинаковый строгий результат `ssl = {}`: `rejectUnauthorized`
остаётся дефолтным `true`, работает штатный `checkServerIdentity`, а `pg`
выставляет `servername`, поэтому имя хоста тоже проверяется.

Но пакет печатает предупреждение: режимы `prefer`, `require` и `verify-ca` —
«are treated as aliases for `verify-full`», и в следующей мажорной версии
(`pg-connection-string` 3.0 / `pg` 9.0) они перейдут на семантику libpq, «which
have weaker security guarantees». Рекомендация самого пакета: «If you want the
current behavior, explicitly use `sslmode=verify-full`».

То есть `require` сегодня проверяет сертификат, но при мажорном апгрейде `pg`
**молча перестанет** это делать. `verify-full` — единственный режим, который
означает одно и то же в обеих ветках и не изменится. Это проверено тестом
`verify-full stays strict even under libpq compatibility`.

Версии сейчас зафиксированы: `pg` 8.16.3 (exact), `pg-connection-string` 2.14.0
в lock-файле, зависимость `^2.9.1` не пустит 3.x. Апгрейд `pg` до 9 нужно
рассматривать как security-breaking.

### Почему CA-бандл не нужен

Neon требует TLS в обязательном порядке и использует публичный сертификат
**ISRG Root X1** от Let's Encrypt, который входит в набор Mozilla, встроенный в
Node. При `verify-full` без `sslrootcert` Node берёт этот набор, поэтому
цепочка и hostname проверяются без каких-либо дополнительных файлов. Neon сам
рекомендует «always use `verify-full` mode».

### Что делает guard в `db/index.ts`

| Конфигурация URL | Поведение |
|---|---|
| `sslmode=verify-full` | принимается |
| `sslmode` отсутствует, `disable`, `allow`, `no-verify` (удалённый хост) | **исключение**, касса закрывается, callback → 500 |
| `uselibpqcompat=true` вместе с любым режимом кроме `verify-full` | **исключение** — там проверка отключена уже сейчас |
| `prefer` / `require` / `verify-ca` | работает, но пишет в лог требование перейти на `verify-full` |
| loopback (`localhost`, `127.0.0.1`, `::1`) | TLS не требуется — так тесты обращаются к своему PostgreSQL |

### Замечания на будущее

- `channel_binding=require` из строки Neon безвреден, но `pg` 8.16 этот параметр
  **не разбирает и не enforce-ит**: SCRAM-SHA-256-PLUS (поддержан с `pg` 8.14)
  применится оппортунистически, если сервер его предложит. Полагаться на
  «require» в этом параметре как на гарантию нельзя.
- Панель Neon по умолчанию выдаёт строку с `sslmode=require`, а не
  `verify-full`, — при копировании параметр нужно заменить вручную.
- Гайд Neon для Node предлагает `ssl: { require: true }`. Ключа `require` в
  Node TLS не существует, он игнорируется; работает такой код лишь потому, что
  непустой объект включает TLS со строгими дефолтами. Этот паттерн не
  воспроизводим — мы `ssl` не передаём вообще.
- Документального подтверждения, что сертификат Neon покрывает хост с суффиксом
  `-pooler` (то есть что `verify-full` гарантированно проходит на pooled-эндпоинте),
  в доках Neon найти не удалось. Логически это следует из их же рекомендации,
  но проверить нужно первым подключением.

---

## 14. B2B-реквизиты покупателя и чек НПД

### Что проверено в документации

Задача: передать в Robokassa ИНН и наименование покупателя-юрлица, чтобы они
попали в чек НПД. Проверены `docs.robokassa.ru` (fiscalization, pay-interface,
second-receipt, receipt-correction, invoice-api), машиночитаемая спецификация
`robokassa.yaml` и продуктовые страницы про Робочеки СМЗ.

**Документированного способа не существует.**

| Канал | Поля покупателя-юрлица |
|---|---|
| Объект `Receipt` | Только два поля верхнего уровня: `sno` и `items`. Полей `client`/`customer`/`buyer` нет |
| Форма `Merchant/Index.aspx` | Только `Email` покупателя. Поля ИНН нет |
| Invoice API | `SupplierInfo.Inn` — это ИНН **поставщика** (агентская схема), не покупателя |
| `Shp_*` | Транзитные параметры, возвращаются в уведомлениях, **в чек не попадают** |
| API второго чека | Объект `client` есть, но в нём только `email` и `phone` |

Реквизиты «покупатель» (тег 1227) и «ИНН покупателя» (тег 1228) в документации
Robokassa не упоминаются нигде. Раздела про B2B-расчёты нет.

**Отдельно и важнее всего:** страница фискализации не содержит ни одного
упоминания слов «самозанятый», «СМЗ», «НПД», «422-ФЗ», «Мой налог». Вся
техническая документация по `Receipt` описывает **ККТ по 54-ФЗ** (`sno` со
значениями `osn`/`usn_income`/…, ставки НДС, признаки предмета расчёта). Робочеки
СМЗ описаны только продуктовой страницей, без технической спецификации. То есть
неизвестно даже, какие поля `Receipt` при формировании чека НПД обрабатываются,
а какие игнорируются.

Поэтому **никаких полей в `Receipt` не добавлено**: выдумывать имена полей для
налогового документа недопустимо.

### Что реализовано

Сбор и хранение реквизитов — они нужны для audit trail и для ручного выставления
чека, которое сейчас является единственным доступным путём.

- Чекаут спрашивает тип покупателя: физическое лицо / ИП или организация.
- Для физлица email обязателен, ИНН не запрашивается.
- Для бизнеса обязательны email, ИНН и наименование.
- Валидация серверная. ИНН проверяется не по длине, а по **контрольной сумме**
  ФНС (10 цифр для организации, 12 для ИП). Строка из одних нулей арифметически
  проходит контрольную сумму, поэтому отвергается отдельно.
- Подмена типа покупателя невозможна в опасную сторону: всё, что не равно
  буквально `business`, трактуется как физлицо — то есть как случай, где
  реквизиты не нужны. Обойти требование ИНН нельзя.
- Реквизиты сохраняются в `orders` и **на уровне данных** связаны CHECK-ограничением
  `orders_buyer_requisites`: заказ business без реквизитов и заказ individual с
  реквизитами физически не могут существовать.
- Реквизиты бизнес-покупателя приходят владельцу в Telegram отдельным блоком с
  пометкой «выставить вручную в «Мой налог»».

### Текущий `Receipt` — без изменений

Проверен и оставлен как есть, поскольку сквозной тестовый платёж на нём прошёл:
одна позиция, `name` — название услуги (≤128 символов), `quantity: 1`,
`sum` равен `OutSum`, `tax: "none"`, `payment_method: "full_prepayment"`,
`payment_object: "service"`, `sno` не передаётся. Закреплено тестом.

Оговорка: прямой цитаты, предписывающей самозанятым именно `tax: "none"`, в
документации Robokassa **нет** — там лишь нейтральное «`none` = без НДС».
Логически для НПД это единственное подходящее значение, но нормативным
подтверждением это не является. Значение не менялось наугад именно поэтому.

### Нерешённый риск

Робочеки СМЗ формируют чек автоматически на каждую оплату. Если при B2B-продаже
автоматически регистрируется чек **физическому лицу**, а владелец дополнительно
выставляет чек юрлицу вручную, возникает риск **двойного чека**. Механики
аннулирования автоматического чека документация не описывает.

Кроме того, оферта (п. 5.3) уже обещает: «Юридическое лицо или ИП дополнительно
указывает наименование и ИНН. Исполнитель формирует и направляет электронный чек
НПД». Сбор реквизитов теперь эту часть выполняет, но автоматическая выдача
корректного B2B-чека не гарантирована до ответа поддержки.

---

# READY FOR INFRASTRUCTURE SETUP

CRITICAL-1 и CRITICAL-2 устранены структурно и закреплены ограничениями БД и 43 тестами. Build, tests и typecheck зелёные. Код готов к созданию инфраструктуры; до создания БД и настройки кабинета Robokassa боевой запуск невозможен, а `docker build` остаётся непроверенным шагом.

---

# NEEDED FROM OWNER

**Действия**

1. Создать базу в Neon и внести **pooled** `DATABASE_URL` с `sslmode=verify-full` в переменные приложения Timeweb (§10).
2. Применить миграцию `npm run db:migrate` с **direct** строкой Neon.
3. Прогнать `docker build` — я не смог, Docker в среде отсутствует.
4. Выполнить настройки в кабинете Robokassa (§11), в первую очередь **SHA-256**.
5. После создания БД прогнать тест конкурентных callback-ов на реальном PostgreSQL.

**Решения**

6. Собирать ли на checkout наименование и ИНН для B2B — оферта (п. 5.3) их обещает, код не передаёт.
7. Нужен ли резервный путь доступа к анкете при потере cookie (например, ссылка на email плательщика).
8. Удалять ли `examples/d1/` — каталог описывает технологию, недоступную на этом хостинге.

**Информация**

9. Подтвердить, что в строках подключения Neon стоит именно `sslmode=verify-full`, а не `require` (§13).
