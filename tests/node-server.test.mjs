import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("portable Node server serves pages and production assets", async (context) => {
  const port = 18_000 + (process.pid % 1_000);
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  context.after(async () => {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => server.once("exit", resolve)),
        delay(3_000).then(() => server.kill("SIGKILL")),
      ]);
    }
    assert.equal(stderr, "");
  });

  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      health = await fetch(`${origin}/health`);
      if (health.ok) break;
    } catch {
      await delay(100);
    }
  }
  assert.equal(health?.status, 200);
  assert.equal(await health.text(), "ok");

  const home = await fetch(origin);
  assert.equal(home.status, 200);
  const html = await home.text();
  const stylesheet = html.match(/href="([^"]+\.css)"/)?.[1];
  assert.ok(stylesheet, "rendered page must reference a stylesheet");

  const [offer, css, checkout] = await Promise.all([
    fetch(`${origin}/offer`),
    fetch(new URL(stylesheet, origin)),
    fetch(`${origin}/api/payment/start`, { redirect: "manual" }),
  ]);
  assert.equal(offer.status, 200);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /^text\/css\b/);
  assert.equal(checkout.status, 303);
  assert.equal(checkout.headers.get("location"), `${origin}/payment/unavailable`);
});
