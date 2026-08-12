import assert from "node:assert/strict";
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
  assert.match(html, /Получить счёт на 4 900 ₽/);
  assert.match(html, /Демонстрационный пример/);
  assert.match(html, /без автопродления/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
  assert.match(html, /не гарантируем победу/i);
});

test("renders the service terms and privacy policy", async () => {
  const [offer, privacy] = await Promise.all([render("/offer"), render("/privacy")]);
  assert.equal(offer.status, 200);
  assert.equal(privacy.status, 200);
  assert.match(await offer.text(), /Условия оказания услуги/);
  assert.match(await privacy.text(), /Политика обработки персональных данных/);
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
