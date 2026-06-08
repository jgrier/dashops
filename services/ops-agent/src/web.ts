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

  if (pathname === "/api/approvals/history" && req.method === "GET") {
    const group = url.searchParams.get("group") ?? "finance-leads";
    const r = await fetch(
      `${RESTATE_INGRESS}/DecidedApprovalsIndex/${encodeURIComponent(group)}/list`,
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

  // ---- service portal ----
  if (pathname === "/services" || pathname === "/services/") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(renderServicesPortal());
    return;
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

// The portal: a static catalog of every service in the demo, with a link
// to its self-hosted ops view. Kept inline (no template file) because it's
// purely static and very small.
function renderServicesPortal(): string {
  const services: Array<{
    name: string;
    role: string;
    restatePort: number;
    uiPort: number;
  }> = [
    { name: "gateway",          role: "Registry, middleware chain, dispatch, cost ledger", restatePort: 9080, uiPort: 9180 },
    { name: "delivery-svc",     role: "delivery_lookup, escalation_history",                restatePort: 9081, uiPort: 9181 },
    { name: "customer-svc",     role: "customer_lookup, apply_credit, customer_outreach",   restatePort: 9082, uiPort: 9182 },
    { name: "ops-agent",        role: "Per-session VOs driving the agent loop",             restatePort: 9083, uiPort: 9183 },
    { name: "guardrails",       role: "PIIGuardrail (regex pre-screen / LLM in live mode)", restatePort: 9084, uiPort: 9184 },
    { name: "approval-service", role: "Async human-in-the-loop approvals + appeals",        restatePort: 9085, uiPort: 9185 },
    { name: "insights-svc",     role: "semantic_search, merchant_status",                   restatePort: 9086, uiPort: 9186 },
    { name: "llm-svc",          role: "Single backend for every LLM call (gateway-routed)", restatePort: 9087, uiPort: 9187 },
  ];
  const cards = services
    .map(
      (s) => `<a class="svc" href="http://localhost:${s.uiPort}" target="_blank">
        <div class="svc-name">${s.name}</div>
        <div class="svc-role">${s.role}</div>
        <div class="svc-ports">
          <span class="muted">restate</span> <code>:${s.restatePort}</code>
          &nbsp;·&nbsp;
          <span class="muted">ops view</span> <code>:${s.uiPort}</code>
        </div>
      </a>`
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>DashOps · services</title>
<style>
:root {
  --bg: #1a1a1a; --surface: #242424; --border: #333;
  --text: #e0e0e0; --muted: #888; --accent: #f55b35; --chip: #2a3a4a; --chip-fg: #88c0d0;
}
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg); color: var(--text); margin: 0; padding: 0; }
.topnav { background: #0e0e0e; padding: 10px 24px; border-bottom: 1px solid #2a3038;
  display: flex; align-items: center; gap: 16px; font-size: 13px; }
.topnav a { color: #9ba6b3; text-decoration: none; }
.topnav a:hover { color: #f55b35; }
.topnav a.active { color: #f55b35; font-weight: 600; }
.container { max-width: 920px; margin: 0 auto; padding: 24px; }
h1 { color: var(--accent); margin: 0 0 4px 0; font-size: 24px; }
.subtitle { color: var(--muted); font-size: 14px; margin-bottom: 24px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.svc { display: block; background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 16px 18px; text-decoration: none; color: inherit;
  transition: border-color 0.15s; }
.svc:hover { border-color: var(--accent); }
.svc-name { color: var(--accent); font-weight: 600; font-size: 15px; margin-bottom: 4px; }
.svc-role { color: var(--text); font-size: 13px; margin-bottom: 8px; }
.svc-ports { font-size: 12px; }
.muted { color: var(--muted); }
code { font-family: ui-monospace, monospace; color: var(--chip-fg); }
</style>
</head>
<body>
<div class="topnav">
  <a href="/operator">operator</a>
  <a href="/approver">approver</a>
  <a href="/services" class="active">services</a>
  <a href="http://localhost:3001/">supervisor</a>
</div>
<div class="container">
  <h1>DashOps services</h1>
  <div class="subtitle">Every service hosts its own ops view. Click through to inspect tools, registry contents, pending approvals, etc.</div>
  <div class="grid">${cards}</div>
</div>
</body>
</html>`;
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
