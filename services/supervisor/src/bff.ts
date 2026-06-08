// Stateless BFF for the entire DashOps demo.
//
// Serves every browser-facing page (operator, approver, services portal)
// and proxies the chat APIs (/api/sessions/*, /api/approvals/*) to the
// Restate ingress. NONE of these handlers touch process-local state on
// the supervisor — every request is a pure function of
// (request) → (file from disk | response from Restate).
//
// The supervisor's process-management responsibility (PIDs, log
// buffers, exit codes) lives in procs.ts and is reachable through a
// disjoint set of /api/services/* and /api/state routes wired in
// index.ts. Two roles, one process, deliberately kept separate.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const RESTATE_INGRESS = process.env.RESTATE_INGRESS ?? "http://localhost:8080";

// ---- entrypoint --------------------------------------------------------

// Returns true if this request was a BFF route and was handled. Index.ts
// dispatches: BFF first, control plane second, 404 last.
export async function handleBff(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webRoot: string
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;

  // ---- session APIs (proxy to Restate ingress) ----
  const sendMatch = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sendMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(sendMatch[1]);
    const body = await readBody(req);
    const { message } = JSON.parse(body);
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/sendMessage/send`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) }
    );
    await relay(r, res);
    return true;
  }

  const stateMatch = p.match(/^\/api\/sessions\/([^/]+)$/);
  if (stateMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(stateMatch[1]);
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/getState`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    await relay(r, res);
    return true;
  }

  const resetMatch = p.match(/^\/api\/sessions\/([^/]+)\/reset$/);
  if (resetMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(resetMatch[1]);
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/reset`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    await relay(r, res);
    return true;
  }

  const appealMatch = p.match(/^\/api\/sessions\/([^/]+)\/appeal$/);
  if (appealMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(appealMatch[1]);
    const r = await fetch(
      `${RESTATE_INGRESS}/Session/${encodeURIComponent(sessionId)}/requestAppeal/send`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    await relay(r, res);
    return true;
  }

  // ---- approval APIs ----
  if (p === "/api/approvals/pending" && req.method === "GET") {
    const group = url.searchParams.get("group") ?? "finance-leads";
    const r = await fetch(
      `${RESTATE_INGRESS}/PendingApprovalsIndex/${encodeURIComponent(group)}/list`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    await relay(r, res);
    return true;
  }

  if (p === "/api/approvals/history" && req.method === "GET") {
    const group = url.searchParams.get("group") ?? "finance-leads";
    const r = await fetch(
      `${RESTATE_INGRESS}/DecidedApprovalsIndex/${encodeURIComponent(group)}/list`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    await relay(r, res);
    return true;
  }

  const respondMatch = p.match(/^\/api\/approvals\/([^/]+)\/respond$/);
  if (respondMatch && req.method === "POST") {
    const approvalId = decodeURIComponent(respondMatch[1]);
    const body = await readBody(req);
    const r = await fetch(
      `${RESTATE_INGRESS}/ApprovalService/${encodeURIComponent(approvalId)}/respond`,
      { method: "POST", headers: { "content-type": "application/json" }, body }
    );
    await relay(r, res);
    return true;
  }

  const approvalGetMatch = p.match(/^\/api\/approvals\/([^/]+)$/);
  if (approvalGetMatch && req.method === "GET") {
    const approvalId = decodeURIComponent(approvalGetMatch[1]);
    const r = await fetch(
      `${RESTATE_INGRESS}/ApprovalService/${encodeURIComponent(approvalId)}/getRecord`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    await relay(r, res);
    return true;
  }

  // ---- /services portal (server-rendered) ----
  if (p === "/services" || p === "/services/") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(renderServicesPortal());
    return true;
  }

  // ---- static chat UIs ----
  if (p === "/" || p === "/operator" || p === "/operator/") {
    return serveStatic("/operator/index.html", res, webRoot);
  }
  if (p === "/approver" || p === "/approver/") {
    return serveStatic("/approver/index.html", res, webRoot);
  }
  if (p.startsWith("/operator/") || p.startsWith("/approver/")) {
    return serveStatic(p, res, webRoot);
  }

  return false;
}

// ---- helpers -----------------------------------------------------------

async function relay(r: Response, res: http.ServerResponse): Promise<void> {
  res.statusCode = r.status;
  res.setHeader("content-type", "application/json");
  res.end(await r.text());
}

async function serveStatic(
  pathname: string,
  res: http.ServerResponse,
  webRoot: string
): Promise<boolean> {
  const filePath = path.join(webRoot, pathname);
  if (!filePath.startsWith(webRoot)) {
    res.statusCode = 403;
    res.end("forbidden");
    return true;
  }
  try {
    const data = await fs.promises.readFile(filePath);
    res.statusCode = 200;
    res.setHeader("content-type", mimeType(filePath));
    res.end(data);
    return true;
  } catch {
    return false;            // let caller fall through to 404
  }
}

function mimeType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---- services portal ---------------------------------------------------

function renderServicesPortal(): string {
  // Each card links to /ops/<name> — supervisor will render it in stage 2.
  // Restate ports are informational; users don't visit them directly.
  const services = [
    { name: "gateway",          role: "Registry, middleware chain, dispatch, cost ledger", restatePort: 9080 },
    { name: "delivery-svc",     role: "delivery_lookup, escalation_history",                restatePort: 9081 },
    { name: "customer-svc",     role: "customer_lookup, apply_credit, customer_outreach",   restatePort: 9082 },
    { name: "ops-agent",        role: "Per-session VOs driving the agent loop",             restatePort: 9083 },
    { name: "guardrails",       role: "PIIGuardrail (regex pre-screen / LLM in live mode)", restatePort: 9084 },
    { name: "approval-service", role: "Async human-in-the-loop approvals + appeals",        restatePort: 9085 },
    { name: "insights-svc",     role: "semantic_search, merchant_status",                   restatePort: 9086 },
    { name: "llm-svc",          role: "Single backend for every LLM call (gateway-routed)", restatePort: 9087 },
  ];
  const cards = services
    .map(
      (s) => `<a class="svc" href="/ops/${s.name}">
        <div class="svc-name">${s.name}</div>
        <div class="svc-role">${s.role}</div>
        <div class="svc-ports"><span class="muted">restate</span> <code>:${s.restatePort}</code></div>
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
  --bg: #0e1116; --surface: #161b22; --surface-2: #1f262e;
  --border: #2a3038; --fg: #e6edf3; --fg-muted: #9ba6b3; --accent: #f55b35;
}
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg); color: var(--fg); margin: 0; }
.topnav { background: #0e0e0e; padding: 10px 24px; border-bottom: 1px solid #2a3038;
  display: flex; align-items: center; gap: 16px; font-size: 13px; }
.topnav a { color: #9ba6b3; text-decoration: none; }
.topnav a:hover { color: #f55b35; }
.topnav a.active { color: #f55b35; font-weight: 600; }
.container { max-width: 920px; margin: 0 auto; padding: 24px; }
h1 { color: var(--accent); margin: 0 0 4px 0; font-size: 22px; }
.subtitle { color: var(--fg-muted); font-size: 13px; margin-bottom: 24px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.svc { display: block; background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 16px 18px; text-decoration: none; color: inherit;
  transition: border-color 0.15s; }
.svc:hover { border-color: var(--accent); }
.svc-name { color: var(--accent); font-weight: 600; font-size: 15px; margin-bottom: 4px; }
.svc-role { color: var(--fg); font-size: 13px; margin-bottom: 8px; }
.svc-ports { font-size: 12px; }
.muted { color: var(--fg-muted); }
code { font-family: ui-monospace, monospace; color: #88c0d0; }
</style>
</head>
<body>
<div class="topnav">
  <a href="/operator">operator</a>
  <a href="/approver">approver</a>
  <a href="/services" class="active">services</a>
  <a href="/supervisor">supervisor</a>
</div>
<div class="container">
  <h1>DashOps services</h1>
  <div class="subtitle">Every service is independently observable. Click into one to see its state.</div>
  <div class="grid">${cards}</div>
</div>
</body>
</html>`;
}
