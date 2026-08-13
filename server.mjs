import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "./dist/server/index.js";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));
const clientDirectory = resolve(rootDirectory, "dist", "client");
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const publicOrigin = normalizeOrigin(process.env.PUBLIC_ORIGIN);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function normalizeOrigin(value) {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute http(s) URL");
  }
}

function requestOrigin(request) {
  if (publicOrigin) return publicOrigin;
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol = String(Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol ?? "http")
    .split(",")[0]
    .trim();
  const host = request.headers.host ?? `127.0.0.1:${port}`;
  return `${protocol === "https" ? "https" : "http"}://${host}`;
}

async function readRequestBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchAsset(assetRequest) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(assetRequest.url).pathname);
  } catch {
    return new Response("Invalid asset path", { status: 400 });
  }

  const relativePath = pathname.replace(/^\/+/, "");
  const absolutePath = resolve(clientDirectory, relativePath);
  if (absolutePath !== clientDirectory && !absolutePath.startsWith(`${clientDirectory}${sep}`)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const details = await stat(absolutePath);
    if (!details.isFile()) return new Response("Not found", { status: 404 });
    const body = await readFile(absolutePath);
    const headers = new Headers({
      "content-type": contentTypes.get(extname(absolutePath).toLowerCase()) ?? "application/octet-stream",
      "content-length": String(body.length),
      "x-content-type-options": "nosniff",
    });
    if (pathname.startsWith("/_next/static/")) {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    } else {
      headers.set("cache-control", "public, max-age=3600");
    }
    return new Response(assetRequest.method === "HEAD" ? null : body, { status: 200, headers });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}

function sendResponse(nodeResponse, response, body, method) {
  nodeResponse.statusCode = response.status;
  nodeResponse.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    if (!(["connection", "keep-alive", "transfer-encoding"].includes(name.toLowerCase()))) {
      nodeResponse.setHeader(name, value);
    }
  }
  if (method === "HEAD") {
    nodeResponse.end();
    return;
  }
  nodeResponse.setHeader("content-length", String(body.length));
  nodeResponse.end(body);
}

const server = createServer(async (nodeRequest, nodeResponse) => {
  try {
    const url = new URL(nodeRequest.url ?? "/", requestOrigin(nodeRequest));
    if (url.pathname === "/health") {
      sendResponse(
        nodeResponse,
        new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } }),
        Buffer.from("ok"),
        nodeRequest.method,
      );
      return;
    }

    if (
      (nodeRequest.method === "GET" || nodeRequest.method === "HEAD") &&
      (url.pathname.startsWith("/_next/") || extname(url.pathname) !== "")
    ) {
      const assetResponse = await fetchAsset(
        new Request(url, { method: nodeRequest.method }),
      );
      if (assetResponse.ok) {
        const assetBody = Buffer.from(await assetResponse.arrayBuffer());
        sendResponse(nodeResponse, assetResponse, assetBody, nodeRequest.method);
        return;
      }
    }

    const body = await readRequestBody(nodeRequest);
    const request = new Request(url, {
      method: nodeRequest.method,
      headers: nodeRequest.headers,
      ...(body ? { body, duplex: "half" } : {}),
    });
    const backgroundTasks = [];
    const response = await worker.fetch(
      request,
      {
        ...process.env,
        ASSETS: { fetch: fetchAsset },
      },
      {
        waitUntil(promise) {
          backgroundTasks.push(Promise.resolve(promise));
        },
        passThroughOnException() {},
      },
    );
    const responseBody = Buffer.from(await response.arrayBuffer());
    sendResponse(nodeResponse, response, responseBody, nodeRequest.method);
    if (backgroundTasks.length > 0) void Promise.allSettled(backgroundTasks);
  } catch (error) {
    console.error("Request failed", error);
    if (!nodeResponse.headersSent) {
      nodeResponse.statusCode = error?.message === "Request body is too large" ? 413 : 500;
      nodeResponse.setHeader("content-type", "text/plain; charset=utf-8");
    }
    nodeResponse.end("Internal Server Error");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`PozTender listening on 0.0.0.0:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
