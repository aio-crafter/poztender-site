import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`https://poztender.example${path}`, {
      headers: { accept: "text/html", "x-forwarded-proto": "https" },
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
  assert.match(html, /href="\/offer"[^>]*class="header-offer"[^>]*>Оферта</);
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

test("creates a signed checkout and validates the payment callback", async () => {
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
    process.env.ROBOKASSA_B2B_RECEIPT_CONFIRMED = "true";

    const checkout = await render("/api/payment/start");
    assert.equal(checkout.status, 200);
    const html = await checkout.text();
    assert.match(html, /auth\.robokassa\.ru\/Merchant\/Index\.aspx/);
    assert.match(html, /name="IsTest" value="1"/);
    assert.match(html, /name="Receipt"/);
    assert.doesNotMatch(html, /test-password-one|test-password-two/);

    const outSum = "4900.00";
    const invoiceId = "123456";
    const signature = createHash("sha256")
      .update(`${outSum}:${invoiceId}:test-password-two`)
      .digest("hex");
    const callback = await render(
      `/api/payment/result?OutSum=${outSum}&InvId=${invoiceId}&SignatureValue=${signature}`,
    );
    assert.equal(callback.status, 200);
    assert.equal(await callback.text(), `OK${invoiceId}`);

    const forged = await render(
      `/api/payment/result?OutSum=${outSum}&InvId=${invoiceId}&SignatureValue=${"0".repeat(64)}`,
    );
    assert.equal(forged.status, 403);
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
