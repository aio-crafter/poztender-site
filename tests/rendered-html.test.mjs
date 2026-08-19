import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/", init) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`https://poztender.example${path}`, {
      headers: { accept: "text/html", "x-forwarded-proto": "https" },
      ...init,
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the sales page with honest CTA and demonstration", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /ПожТендер/);
  assert.match(html, /Оплатить 4 900 ₽ онлайн/);
  assert.match(html, /Демонстрационный пример/);
  assert.match(html, /без автопродления/i);
  assert.match(html, /<a[^>]*(?:href="\/offer"[^>]*class="header-offer"|class="header-offer"[^>]*href="\/offer")[^>]*>Оферта<\/a>/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
  assert.match(html, /не гарантируем победу/i);
});

test("renders the service terms and privacy policy", async () => {
  const [offer, privacy] = await Promise.all([render("/offer"), render("/privacy")]);
  assert.equal(offer.status, 200);
  assert.equal(privacy.status, 200);
  assert.match(await offer.text(), /Публичная оферта/);
  assert.match(await privacy.text(), /Политика обработки персональных данных/);
});

test("renders payment pages and keeps checkout unavailable without secrets", async () => {
  const [payment, unavailable, checkout] = await Promise.all([
    render("/payment"),
    render("/payment/unavailable"),
    render("/api/payment/start"),
  ]);
  assert.equal(payment.status, 200);
  assert.equal(unavailable.status, 200);
  assert.equal(checkout.status, 303);
  assert.equal(
    checkout.headers.get("location"),
    "https://poztender.example/payment/unavailable",
  );
  assert.match(await payment.text(), /Robokassa/);
  assert.match(await unavailable.text(), /Онлайн-оплата подключается/);
});

test("keeps the intake form closed for a bare invoice number", async () => {
  // An invoice number on its own is not proof of payment: the form only opens
  // for a link carrying a signed access token. The paid path is covered in
  // tests/payment.test.mjs.
  const brief = await render("/brief?InvId=123456");
  assert.equal(brief.status, 200);
  const html = await brief.text();
  assert.match(html, /Анкета доступна после оплаты/);
  assert.doesNotMatch(html, /Единая точка старта/);
});

test("checks paid access before it looks at the intake payload", async () => {
  // Both requests are rejected as unpaid rather than as malformed: the payment
  // gate runs first, so an unpaid caller cannot probe the validation rules.
  const invalid = await render("/api/intake", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.10" },
    body: JSON.stringify({ company: "" }),
  });
  assert.equal(invalid.status, 402);

  const validPayload = {
    company: "ООО ПожСервис",
    inn: "6312345678",
    contactName: "Александр",
    email: "client@example.ru",
    telegram: "@client_test",
    replyChannel: "telegram",
    regions: "Самарская область",
    workTypes: "Монтаж и обслуживание АПС и СОУЭ",
    budget: "от 300 000 до 5 000 000 рублей",
    licenses: "Лицензия МЧС",
    exclusions: "Не менее пяти дней до подачи",
    invoiceId: "123456",
    website: "",
    consent: true,
  };
  const unpaid = await render("/api/intake", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.11" },
    body: JSON.stringify(validPayload),
  });
  assert.equal(unpaid.status, 402);
});

test("payment endpoints fail closed when no order store is configured", async () => {
  // This file deliberately runs without DATABASE_URL. A payment that cannot be
  // recorded must not be started, and a callback that cannot be persisted must
  // not be acknowledged. The full flow against a real PostgreSQL lives in
  // tests/payment.test.mjs.
  const variableNames = [
    "ROBOKASSA_MERCHANT_LOGIN",
    "ROBOKASSA_PASSWORD_1",
    "ROBOKASSA_PASSWORD_2",
    "ROBOKASSA_TEST_MODE",
    "ROBOKASSA_B2B_RECEIPT_CONFIRMED",
  ];
  const previous = Object.fromEntries(variableNames.map((name) => [name, process.env[name]]));

  try {
    process.env.ROBOKASSA_MERCHANT_LOGIN = "poztender-test";
    process.env.ROBOKASSA_PASSWORD_1 = "test-password-one";
    process.env.ROBOKASSA_PASSWORD_2 = "test-password-two";
    process.env.ROBOKASSA_TEST_MODE = "true";
    process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "false";

    const checkout = await render("/api/payment/start?email=buyer%40example.ru");
    assert.equal(checkout.status, 303);
    assert.equal(
      checkout.headers.get("location"),
      "https://poztender.example/payment/unavailable",
    );

    const outSum = "4900.00";
    const invoiceId = "123456";
    const signature = createHash("sha256")
      .update(`${outSum}:${invoiceId}:test-password-two`)
      .digest("hex");
    const callback = await render(
      `/api/payment/result?OutSum=${outSum}&InvId=${invoiceId}&SignatureValue=${signature}`,
    );
    assert.equal(callback.status, 503);
    assert.doesNotMatch(await callback.text(), /^OK/);
  } finally {
    for (const name of variableNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("starter-only markers are gone from source", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const source = `${page}\n${layout}\n${packageJson}`;
  assert.doesNotMatch(source, /SkeletonPreview|codex-preview|react-loading-skeleton|Starter Project/);
  assert.match(layout, /\/og\.png/);
});
