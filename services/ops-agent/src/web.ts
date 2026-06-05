import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Walk up from services/ops-agent/src/web.ts (or dist/) to repo root, then web/operator
const WEB_ROOT = path.resolve(__dirname, "..", "..", "..", "web", "operator");

const RESTATE_INGRESS = process.env.RESTATE_INGRESS ?? "http://localhost:8080";

// ---------------------------------------------------------------------------
// Web bridge: serves the operator UI, proxies its HTTP calls to Restate
// ingress. Two endpoints matter:
//   POST /api/sessions/:id/messages   — fire-and-forget message to the agent
//   GET  /api/sessions/:id            — fetch current session state
// ---------------------------------------------------------------------------

export function startWebBridge(port: number): void {
  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: msg }));
    }
  });
  server.listen(port, () => {
    console.log(`Operator UI bridge listening on http://localhost:${port}`);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const pathname = url.pathname;

  // API: send a message
  const sendMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sendMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(sendMatch[1]);
    const body = await readBody(req);
    const { message } = JSON.parse(body);
    // Async send so the HTTP call returns immediately; agent runs in background.
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/sendMessage/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      }
    );
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.end(await r.text());
    return;
  }

  // API: get session state
  const stateMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (stateMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(stateMatch[1]);
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/getState`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }
    );
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.end(await r.text());
    return;
  }

  // API: reset
  const resetMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/reset$/);
  if (resetMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(resetMatch[1]);
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/reset`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.end(await r.text());
    return;
  }

  // Static file serving
  await serveStatic(pathname, res);
}

async function serveStatic(pathname: string, res: http.ServerResponse) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(WEB_ROOT, safePath);
  if (!filePath.startsWith(WEB_ROOT)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  try {
    const data = await fs.promises.readFile(filePath);
    res.statusCode = 200;
    res.setHeader("content-type", mimeType(filePath));
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function mimeType(p: string): string {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
