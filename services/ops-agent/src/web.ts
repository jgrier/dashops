import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_ROOT = path.resolve(__dirname, "..", "..", "..", "web");

const RESTATE_INGRESS = process.env.RESTATE_INGRESS ?? "http://localhost:8080";

// ---------------------------------------------------------------------------
// Web bridge: serves the operator + approver UIs and proxies their HTTP
// calls to the Restate ingress.
//   POST /api/sessions/:id/messages       — fire-and-forget message to agent
//   GET  /api/sessions/:id                — fetch session state
//   POST /api/sessions/:id/reset          — wipe session
//   GET  /api/approvals/pending?group=X   — list pending approvals for a group
//   GET  /api/approvals/:id               — fetch one approval record
//   POST /api/approvals/:id/respond       — approve or reject
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
    console.log(`Web bridge listening on http://localhost:${port}`);
    console.log(`  operator: http://localhost:${port}/operator`);
    console.log(`  approver: http://localhost:${port}/approver`);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const pathname = url.pathname;

  // ---- session APIs ----
  const sendMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sendMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(sendMatch[1]);
    const body = await readBody(req);
    const { message } = JSON.parse(body);
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/sendMessage/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      }
    );
    return relay(r, res);
  }

  const stateMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (stateMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(stateMatch[1]);
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/getState`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    return relay(r, res);
  }

  const resetMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/reset$/);
  if (resetMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(resetMatch[1]);
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/reset`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    return relay(r, res);
  }

  // POST /api/sessions/:id/appeal — operator escalates the current block.
  // Fire-and-forget; the session VO suspends on an awakeable.
  const appealMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/appeal$/);
  if (appealMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(appealMatch[1]);
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/requestAppeal/send`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    return relay(r, res);
  }

  // ---- approval APIs ----
  if (pathname === "/api/approvals/pending" && req.method === "GET") {
    const group = url.searchParams.get("group") ?? "finance-leads";
    const r = await fetch(
      `${RESTATE_INGRESS}/PendingApprovalsIndex/${encodeURIComponent(group)}/list`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    return relay(r, res);
  }

  const respondMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/respond$/);
  if (respondMatch && req.method === "POST") {
    const approvalId = decodeURIComponent(respondMatch[1]);
    const body = await readBody(req);
    const r = await fetch(
      `${RESTATE_INGRESS}/ApprovalService/${encodeURIComponent(approvalId)}/respond`,
      { method: "POST", headers: { "content-type": "application/json" }, body }
    );
    return relay(r, res);
  }

  const approvalGetMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (approvalGetMatch && req.method === "GET") {
    const approvalId = decodeURIComponent(approvalGetMatch[1]);
    const r = await fetch(
      `${RESTATE_INGRESS}/ApprovalService/${encodeURIComponent(approvalId)}/getRecord`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    return relay(r, res);
  }

  // ---- static ----
  // Root → operator UI
  if (pathname === "/") {
    return serveStatic("/operator/index.html", res);
  }
  // /operator and /approver may come with or without trailing slash
  if (pathname === "/operator" || pathname === "/operator/") {
    return serveStatic("/operator/index.html", res);
  }
  if (pathname === "/approver" || pathname === "/approver/") {
    return serveStatic("/approver/index.html", res);
  }
  return serveStatic(pathname, res);
}

async function relay(r: Response, res: http.ServerResponse) {
  res.statusCode = r.status;
  res.setHeader("content-type", "application/json");
  res.end(await r.text());
}

async function serveStatic(pathname: string, res: http.ServerResponse) {
  const filePath = path.join(WEB_ROOT, pathname);
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
    const chunks: Buffer[] = [];
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
