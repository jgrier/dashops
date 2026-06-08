// Stateless BFF — standalone Node process, started by the supervisor as
// a child like any other service.
//
// Serves every browser-facing page (operator, approver, services portal,
// per-service ops views) and proxies the chat APIs to the Restate
// ingress. Every handler is a pure function of (request) → (file from
// disk | response from Restate). No state lives in this process; if you
// kill it, chat UIs go dark, but nothing is lost — start it back up and
// they return.
//
// Used to be services/supervisor/src/bff.ts (a handleBff export wired
// into the supervisor's HTTP router); the supervisor is now a pure TUI
// and this is its own service.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_ROOT = path.resolve(__dirname, "..", "..", "..", "web");

const RESTATE_INGRESS = process.env.RESTATE_INGRESS ?? "http://localhost:8080";
const PORT = parseInt(process.env.BFF_PORT ?? "3001", 10);

async function dispatch(
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

  // ---- live rate-limit edit (proxy to ToolRegistry.updateRateLimit) ----
  const rlMatch = p.match(/^\/api\/tools\/([^/]+)\/ratelimit$/);
  if (rlMatch && req.method === "POST") {
    const toolName = decodeURIComponent(rlMatch[1]);
    const body = await readBody(req);
    const parsed = JSON.parse(body) as { perMinute: number };
    const r = await fetch(
      `${RESTATE_INGRESS}/ToolRegistry/default/updateRateLimit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName, perMinute: parsed.perMinute }),
      }
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

  // ---- /ops/<svc> per-service ops view ----
  // Each per-service page is rendered HERE in the web tier. The BFF fetches
  // narrow JSON snapshots from each service's normal Restate handlers (no
  // HTML crosses the Restate boundary) and composes the HTML itself.
  const opsMatch = p.match(/^\/ops\/([^/]+)\/?$/);
  if (opsMatch && req.method === "GET") {
    const shortName = decodeURIComponent(opsMatch[1]);
    const renderer = OPS_PAGES[shortName];
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (!renderer) {
      res.statusCode = 404;
      res.end(renderOpsShell(shortName, `<div class="empty">Unknown service: ${shortName}</div>`));
      return true;
    }
    try {
      const body = await renderer();
      res.statusCode = 200;
      res.end(renderOpsShell(shortName, body));
      return true;
    } catch (e) {
      res.statusCode = 200;
      res.end(renderOpsShell(shortName, `<div class="empty">Couldn't render <code>${shortName}</code>: ${escapeHtml((e as Error).message)}</div>`));
      return true;
    }
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// One renderer per service. Each fetches exactly the bits it needs from
// the relevant Restate handlers (no HTML lives in the services) and
// returns the page body. The shell + topnav comes from renderOpsShell.
const OPS_PAGES: Record<string, () => Promise<string>> = {
  "gateway": renderGatewayPage,
  "delivery-svc": () => renderToolCountersPage("delivery-svc", "DeliverySvc", "Delivery-domain reads: lookups by delivery ID and escalation history.", "DeliveryLookup, EscalationHistory"),
  "customer-svc": renderCustomerSvcPage,
  "ops-agent": renderOpsAgentPage,
  "guardrails": renderGuardrailsPage,
  "approval-service": renderApprovalServicePage,
  "insights-svc": () => renderToolCountersPage("insights-svc", "InsightsSvc", "Analytical/external lookups: similar-complaint search and merchant status.", "SemanticSearch, MerchantStatus"),
  "llm-svc": renderLlmSvcPage,
};

// Helper for the parallel-call pattern: best-effort fetches that fall back
// to null on any error. The page renderers handle nulls by showing a
// "service down" placeholder for that section only — not the whole page.
async function tryFetchJSON<T = unknown>(url: string, body = "{}"): Promise<T | null> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function pageHeader(displayName: string, role: string): string {
  return `<h1>${escapeHtml(displayName)}</h1><div class="role">${escapeHtml(role)}</div>`;
}

function section(title: string, body: string): string {
  return `<div class="card"><h2>${escapeHtml(title)}</h2>${body}</div>`;
}

function emptySection(title: string, msg: string): string {
  return section(title, `<div class="empty">${escapeHtml(msg)}</div>`);
}

// ---- Gateway page renderer --------------------------------------------

interface ToolRegistration {
  name: string;
  serviceName: string;
  handlerName: string;
  description: string;
  configuredCostCents: number;
  rateLimit?: { perMinute: number };
}

interface CallLogEntry {
  timestampMs: number;
  kind: "tool" | "llm";
  toolName: string;
  status: "ok" | "needs_approval" | "blocked";
  source?: string;
  reason?: string;
  tenantId: string;
  sessionId: string;
  traceId?: string;
  costCents?: number;
  waitedMs?: number;
  appealable?: boolean;
  invocationId?: string;
}

interface BucketState {
  key: string;
  tokens: number | null;
  lastRefillMs: number | null;
  capacity: number | null;
  refillRate: number | null;
  nextRefillMs: number | null;
}

interface CostEntry {
  toolName: string;
  costCents: number;
  timestampMs: number;
  sessionId: string;
}

interface CostSummary {
  tenantId: string;
  totalCents: number;
  entries: CostEntry[];
}

const KNOWN_TENANTS = ["demo-tenant", "platform"];
const ADMIN_UI = process.env.RESTATE_ADMIN_UI ?? "http://localhost:9070";

// Static knowledge the web tier holds about the gateway's middleware chain.
// The chain is a property of the gateway's implementation; surfacing it
// here in the BFF is fine — it doesn't change at runtime.
const GATEWAY_MIDDLEWARES = ["pii-guardrail", "approval-policy", "rate-limit"];

async function renderGatewayPage(): Promise<string> {
  const role = "Every agent ↔ tool/LLM call passes through here: registry lookup → middleware chain → dispatch → cost + audit. State below is read live from the durable VOs.";

  // Parallel fetch — tools first since the buckets depend on the list.
  const tools = await tryFetchJSON<ToolRegistration[]>(`${RESTATE_INGRESS}/ToolRegistry/default/list`);
  const [calls, costSummaries, buckets] = await Promise.all([
    tryFetchJSON<CallLogEntry[]>(`${RESTATE_INGRESS}/Gateway/recentCalls`),
    Promise.all(KNOWN_TENANTS.map((t) => tryFetchJSON<CostSummary>(`${RESTATE_INGRESS}/CostLedger/${t}/summary`))),
    Promise.all(
      (tools ?? []).map((t) =>
        tryFetchJSON<BucketState>(`${RESTATE_INGRESS}/TokenBucket/${encodeURIComponent("tenant_tool:demo-tenant:" + t.name)}/state`)
      )
    ),
  ]);

  const sections: string[] = [];
  sections.push(
    section(
      "Middleware chain",
      `<table>
        <thead><tr><th>order</th><th>middleware</th></tr></thead>
        <tbody>${GATEWAY_MIDDLEWARES.map(
          (mw, i) => `<tr><td class="muted">${i + 1}</td><td><span class="chip">${escapeHtml(mw)}</span></td></tr>`
        ).join("")}</tbody>
      </table>`
    )
  );
  sections.push(renderToolRegistrySection(tools));
  sections.push(renderBucketsSection(tools, buckets));
  sections.push(renderCostLedgerSection(costSummaries.filter((s): s is CostSummary => !!s)));
  sections.push(renderRecentCallsSection(calls));
  sections.push(
    section(
      "Service info",
      `<table>
        <tr><td class="muted">restate port</td><td><code>:9080</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>Gateway</code>, <code>ToolRegistry</code>, <code>CostLedger</code>, <code>TokenBucket</code></td></tr>
        <tr><td class="muted">admin UI</td><td><a href="${ADMIN_UI}/ui/" target="_blank">${ADMIN_UI}/ui/</a></td></tr>
      </table>`
    )
  );
  return pageHeader("gateway", role) + sections.join("");
}

function renderToolRegistrySection(tools: ToolRegistration[] | null): string {
  if (!tools) return emptySection("Tool registry", "Registry unreachable (gateway down?).");
  if (tools.length === 0) return emptySection("Tool registry", "No tools registered yet.");
  const rows = tools
    .map(
      (t) => `<tr>
        <td><span class="chip">${escapeHtml(t.name)}</span></td>
        <td><code>${escapeHtml(t.serviceName)}</code></td>
        <td class="muted">${t.rateLimit?.perMinute ?? "—"}/min</td>
        <td class="muted">${t.configuredCostCents}¢</td>
        <td class="muted">${escapeHtml(t.description)}</td>
      </tr>`
    )
    .join("");
  return section(
    "Tool registry",
    `<table><thead><tr><th>tool</th><th>impl</th><th>rate</th><th>cost</th><th>description</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

function fillBar(tokens: number | null, capacity: number): string {
  const t = tokens ?? capacity;
  const pct = Math.max(0, Math.min(100, (t / capacity) * 100));
  const color = pct > 60 ? "#4dd478" : pct > 25 ? "#ffcc4d" : "#f55b35";
  return `<div style="display:inline-block;width:120px;height:8px;background:#2a2a2a;border-radius:4px;overflow:hidden;vertical-align:middle"><div style="width:${pct}%;height:100%;background:${color};transition:width 0.3s"></div></div>`;
}

function renderBucketsSection(tools: ToolRegistration[] | null, buckets: Array<BucketState | null>): string {
  if (!tools || tools.length === 0) return emptySection("Rate-limit buckets (live, durable in Restate)", "No tools yet.");

  // Compose rows with the live token count from each bucket's state. If a
  // bucket hasn't been acquired against yet, fall back to capacity from the
  // tool registration so the row isn't blank.
  const rows = tools.map((t, i) => {
    const cap = t.rateLimit?.perMinute ?? 60;
    const st = buckets[i];
    const tokens = st?.tokens ?? cap;
    const fillPct = tokens / cap;
    const eta = st?.nextRefillMs != null
      ? `+1 in ${(st.nextRefillMs / 1000).toFixed(1)}s`
      : `<span class="muted">full</span>`;
    return {
      name: t.name,
      cap,
      tokens,
      fillPct,
      eta,
      touched: !!st?.lastRefillMs,
    };
  });

  // Sort: most-depleted first so the interesting ones float to the top.
  // Untouched buckets (effectively "full, idle") go to the bottom.
  rows.sort((a, b) => {
    if (a.touched !== b.touched) return a.touched ? -1 : 1;
    return a.fillPct - b.fillPct;
  });

  const html = rows
    .map(
      (r) => `<tr>
        <td><span class="chip">${escapeHtml(r.name)}</span></td>
        <td>${fillBar(r.tokens, r.cap)}</td>
        <td class="counter">${r.tokens.toFixed(1)} / ${r.cap}</td>
        <td>
          <button onclick="dashops.rl('${escapeHtml(r.name)}', -1)" style="background:#2a2a2a;color:#e0e0e0;border:1px solid #444;border-radius:3px;width:22px;height:22px;cursor:pointer;font-size:13px;line-height:1">−</button>
          <span class="muted" style="display:inline-block;min-width:54px;text-align:center">${r.cap}/min</span>
          <button onclick="dashops.rl('${escapeHtml(r.name)}', +1)" style="background:#2a2a2a;color:#e0e0e0;border:1px solid #444;border-radius:3px;width:22px;height:22px;cursor:pointer;font-size:13px;line-height:1">+</button>
        </td>
        <td class="muted">${r.eta}</td>
      </tr>`
    )
    .join("");

  return section(
    "Rate-limit buckets (live, durable in Restate)",
    `<table><thead><tr><th>tool</th><th>fill</th><th>tokens</th><th>capacity (live edit)</th><th>next refill</th></tr></thead><tbody>${html}</tbody></table>
     <div class="muted" style="font-size:12px;margin-top:8px">
       Showing the <code>tenant_tool:demo-tenant:&lt;tool&gt;</code> bucket per tool, sorted by remaining capacity (most depleted first). Tokens computed live on read so the buckets visibly trickle back up between page refreshes. Use the −/+ buttons to change the per-minute limit on the fly — the next call's <code>acquire</code> picks up the new value, and lowering it clamps the bucket down immediately.
     </div>
     <script>
       window.dashops = window.dashops || {};
       window.dashops.rl = async function(tool, delta) {
         // Find this row's current cap from the displayed text. The "/min"
         // span lives between the - and + buttons; parse it.
         const btns = document.querySelectorAll('button');
         let curr = null;
         for (const b of btns) {
           if (b.outerHTML.includes(tool) && b.nextElementSibling) {
             curr = parseInt(b.nextElementSibling.textContent, 10);
             break;
           }
         }
         if (!curr) return;
         const next = Math.max(1, curr + delta * (curr >= 20 ? 5 : 1));
         await fetch('/api/tools/' + encodeURIComponent(tool) + '/ratelimit', {
           method: 'POST',
           headers: { 'content-type': 'application/json' },
           body: JSON.stringify({ perMinute: next }),
         });
         // The page meta-refreshes every 3s — but trigger an immediate one so
         // the change shows up without waiting.
         location.reload();
       };
     </script>`
  );
}

function renderCostLedgerSection(summaries: CostSummary[]): string {
  const populated = summaries.filter((s) => s.totalCents > 0 || s.entries.length > 0);
  if (populated.length === 0) return emptySection("Cost ledger (live, durable in Restate)", "No cost recorded yet.");
  const blocks = populated.map((s) => {
    const byTool = new Map<string, { count: number; cents: number }>();
    for (const e of s.entries) {
      const cur = byTool.get(e.toolName) ?? { count: 0, cents: 0 };
      cur.count += 1;
      cur.cents += e.costCents;
      byTool.set(e.toolName, cur);
    }
    const aggRows = [...byTool.entries()]
      .sort((a, b) => b[1].cents - a[1].cents)
      .map(
        ([tool, v]) => `<tr>
          <td><span class="chip">${escapeHtml(tool)}</span></td>
          <td class="muted">${v.count}</td>
          <td class="counter">${v.cents}¢</td>
        </tr>`
      )
      .join("");
    return `<div style="margin-bottom:18px">
      <div style="font-size:13px;margin-bottom:8px">
        <strong>Tenant <code>${escapeHtml(s.tenantId)}</code></strong> · total spend
        <span class="counter">${s.totalCents}¢</span>
        (${(s.totalCents / 100).toFixed(2)} USD)
      </div>
      <table style="font-size:12px"><tbody>${aggRows}</tbody></table>
    </div>`;
  });
  return section("Cost ledger (live, durable in Restate)", blocks.join(""));
}

function statusPill(c: CallLogEntry): string {
  if (c.status === "ok") {
    const kindMark = c.kind === "llm" ? ` <span style="opacity:0.7;font-size:10px">llm</span>` : "";
    return `<span class="chip" style="background:#1f3a1f;color:#9ce19c">ok${kindMark}</span>`;
  }
  if (c.status === "needs_approval") return `<span class="chip" style="background:#3a2a05;color:#ffd28e">needs_approval</span>`;
  if (c.appealable) return `<span class="chip" style="background:#3a1f1f;color:#ffb0a0">blocked · appealable</span>`;
  return `<span class="chip" style="background:#3a1f1f;color:#ffb0a0">blocked</span>`;
}

function renderRecentCallsSection(calls: CallLogEntry[] | null): string {
  if (!calls) return emptySection("Recent calls (grouped by agent turn)", "Gateway down — no recent-call log to read.");
  if (calls.length === 0) return emptySection("Recent calls (grouped by agent turn)", "No calls yet — fire something from the operator UI.");

  // Group consecutive entries by traceId. One Session.sendMessage mints
  // a fresh traceId and threads it through every downstream gateway call.
  const groups: Array<{ traceId: string | null; calls: CallLogEntry[] }> = [];
  for (const c of calls) {
    const key = c.traceId ?? null;
    const head = groups[groups.length - 1];
    if (head && head.traceId === key) head.calls.push(c);
    else groups.push({ traceId: key, calls: [c] });
  }

  const renderRow = (c: CallLogEntry) => {
    const detail = [c.source ? `<code>${escapeHtml(c.source)}</code>` : null, c.reason ? escapeHtml(c.reason) : null]
      .filter(Boolean)
      .join(" — ");
    const waited = c.waitedMs ? ` <span class="muted">(+${c.waitedMs}ms rate-wait)</span>` : "";
    const cost = c.costCents ? ` <span class="muted">${c.costCents}¢</span>` : "";
    const time = c.invocationId
      ? `<a href="${ADMIN_UI}/ui/invocations/${encodeURIComponent(c.invocationId)}" target="_blank" class="muted" title="open in Restate admin">${new Date(c.timestampMs).toLocaleTimeString()} ↗</a>`
      : `<span class="muted">${new Date(c.timestampMs).toLocaleTimeString()}</span>`;
    return `<tr><td>${time}</td><td><span class="chip">${escapeHtml(c.toolName)}</span></td><td>${statusPill(c)}</td><td>${detail}${waited}${cost}</td></tr>`;
  };

  const rendered = groups.map((g) => {
    const head = g.calls[0];
    const tail = g.calls[g.calls.length - 1];
    const totalCost = g.calls.reduce((s, c) => s + (c.costCents ?? 0), 0);
    const label = g.traceId ? `<code>turn ${escapeHtml(g.traceId.slice(0, 8))}</code>` : `<span class="muted">untagged</span>`;
    const sessionMark = head.sessionId ? ` · <span class="muted">session ${escapeHtml(head.sessionId)}</span>` : "";
    const durationMs = Math.max(0, head.timestampMs - tail.timestampMs);
    const costMark = totalCost ? ` · <span class="counter">${totalCost}¢</span>` : "";
    return `<div style="margin-bottom:14px;border-left:2px solid #f55b35;padding-left:10px;background:rgba(245,91,53,0.04)">
      <div class="muted" style="font-size:11px;margin-bottom:4px">${label}${sessionMark} · ${g.calls.length} call${g.calls.length === 1 ? "" : "s"} · ${durationMs}ms${costMark}</div>
      <table><tbody>${g.calls.map(renderRow).join("")}</tbody></table>
    </div>`;
  });

  return section(
    "Recent calls (grouped by agent turn)",
    rendered.join("") +
      `<div class="muted" style="font-size:12px;margin-top:8px">Each cluster is one agent turn (one operator "send" click). Click a timestamp to open the underlying invocation in the Restate admin UI.</div>`
  );
}

// ---- Tool-counter pages (delivery-svc, insights-svc) -------------------

interface ToolCounterSnapshot {
  name: string;
  count: number;
  lastInvokedAt: number | null;
}

async function renderToolCountersPage(
  shortName: string,
  restateService: string,
  role: string,
  serviceList: string
): Promise<string> {
  const counters = await tryFetchJSON<ToolCounterSnapshot[]>(`${RESTATE_INGRESS}/${restateService}/toolCounters`);
  const toolsBody = counters
    ? `<table>
        <thead><tr><th>tool</th><th>invocations</th><th>last call</th></tr></thead>
        <tbody>${counters
          .map(
            (s) => `<tr>
              <td><span class="chip">${escapeHtml(s.name)}</span></td>
              <td class="counter">${s.count}</td>
              <td class="muted">${s.lastInvokedAt ? new Date(s.lastInvokedAt).toLocaleTimeString() : "—"}</td>
            </tr>`
          )
          .join("")}</tbody>
      </table>`
    : `<div class="empty">Service down — couldn't read counters.</div>`;
  const restatePort = SERVICE_PORTS[shortName];
  return (
    pageHeader(shortName, role) +
    section("Tools served", toolsBody) +
    section(
      "Service info",
      `<table>
        <tr><td class="muted">restate port</td><td><code>:${restatePort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>${escapeHtml(serviceList)}</code>, <code>${escapeHtml(restateService)}</code></td></tr>
      </table>`
    )
  );
}

const SERVICE_PORTS: Record<string, number> = {
  "gateway": 9080,
  "delivery-svc": 9081,
  "customer-svc": 9082,
  "ops-agent": 9083,
  "guardrails": 9084,
  "approval-service": 9085,
  "insights-svc": 9086,
  "llm-svc": 9087,
};

// ---- Customer-svc page (counters + buggy mode) -------------------------

async function renderCustomerSvcPage(): Promise<string> {
  const role = "Customer-domain reads and writes: profile lookup, credit application, outreach.";
  const [counters, buggy] = await Promise.all([
    tryFetchJSON<ToolCounterSnapshot[]>(`${RESTATE_INGRESS}/CustomerSvc/toolCounters`),
    tryFetchJSON<{ on: boolean }>(`${RESTATE_INGRESS}/CustomerSvc/buggyMode`),
  ]);

  const toolsBody = counters
    ? `<table>
        <thead><tr><th>tool</th><th>invocations</th><th>last call</th></tr></thead>
        <tbody>${counters
          .map(
            (s) => `<tr>
              <td><span class="chip">${escapeHtml(s.name)}</span></td>
              <td class="counter">${s.count}</td>
              <td class="muted">${s.lastInvokedAt ? new Date(s.lastInvokedAt).toLocaleTimeString() : "—"}</td>
            </tr>`
          )
          .join("")}</tbody>
      </table>`
    : `<div class="empty">Service down — couldn't read counters.</div>`;

  return (
    pageHeader("customer-svc", role) +
    section("Tools served", toolsBody) +
    section(
      "Notable behavior",
      `<table>
        <tr><td><span class="chip">apply_credit</span></td><td class="muted">Approval-gated when amount &gt; $10 → <code>finance-leads</code></td></tr>
        <tr><td><span class="chip">customer_outreach</span></td><td class="muted">PII guardrail can block params (appeals route to <code>ops-managers</code>)</td></tr>
        <tr><td><span class="chip">apply_credit</span></td><td class="muted">v1 has a deliberate non-whole-dollar bug under <code>BUGGY_MODE=1</code></td></tr>
      </table>`
    ) +
    section(
      "Service info",
      `<table>
        <tr><td class="muted">restate port</td><td><code>:9082</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>CustomerLookup, ApplyCredit, CustomerOutreach</code>, <code>CustomerSvc</code></td></tr>
        <tr><td class="muted">buggy mode</td><td><code>${buggy === null ? "?" : buggy.on ? "ON" : "off"}</code></td></tr>
      </table>`
    )
  );
}

// ---- Other service pages (static-only or read existing handlers) -------

async function renderOpsAgentPage(): Promise<string> {
  const role = "Per-session VOs that drive a fake LLM loop, call tools through the gateway, and suspend on approvals/appeals.";
  const statuses: Array<[string, string]> = [
    ["idle", "no active turn"],
    ["thinking", "running the planner / LLM"],
    ["calling_tool", "awaiting a Gateway.callTool"],
    ["needs_approval", "suspended on an awakeable; an approver must decide"],
    ["blocked_appealable", "guardrail blocked; operator may escalate"],
    ["appeal_pending", "suspended awaiting an appeal decision"],
    ["complete", "turn finished"],
    ["failed", "unrecoverable"],
  ];
  const statusRows = statuses
    .map(([k, v]) => `<tr><td><span class="chip">${k}</span></td><td class="muted">${escapeHtml(v)}</td></tr>`)
    .join("");
  return (
    pageHeader("ops-agent", role) +
    section("Session statuses", `<table>${statusRows}</table>`) +
    section(
      "Live chat surfaces",
      `<table>
        <tr><td class="muted">operator UI</td><td><a href="/operator">/operator</a></td></tr>
        <tr><td class="muted">approver UI</td><td><a href="/approver">/approver</a></td></tr>
      </table>`
    ) +
    section(
      "Service info",
      `<table>
        <tr><td class="muted">restate port</td><td><code>:9083</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>Session</code></td></tr>
      </table>`
    )
  );
}

async function renderGuardrailsPage(): Promise<string> {
  const role = "Outbound safety checks called from gateway middlewares. Stub regex pre-screen today; LLM classifier in live mode.";
  return (
    pageHeader("guardrails", role) +
    section(
      "Active guardrails",
      `<table>
        <thead><tr><th>guardrail</th><th>kind</th><th>mode</th></tr></thead>
        <tbody>
          <tr><td><span class="chip">PIIGuardrail</span></td><td>regex pre-screen</td><td class="muted">stub (phone, ssn, credit-card patterns)</td></tr>
        </tbody>
      </table>`
    ) +
    section(
      "How it's wired",
      `<div class="muted" style="font-size:13px; line-height:1.6">
        Called by <code>gateway/src/middlewares/pii-guardrail.ts</code> on every outbound tool call.
        On flag, returns <code>block_appealable</code> so the operator can escalate via <code>ops-managers</code>.
        See <a href="/ops/gateway">gateway ops view</a> for the chain order.
      </div>`
    ) +
    section(
      "Service info",
      `<table>
        <tr><td class="muted">restate port</td><td><code>:9084</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>PIIGuardrail</code></td></tr>
      </table>`
    )
  );
}

interface PendingApprovalSummary {
  approvalId: string;
  actionSummary: string;
  initiator: { userId: string; sessionId: string };
  createdAtMs: number;
  toolName: string;
  kind?: "approval" | "appeal";
}

async function renderApprovalServicePage(): Promise<string> {
  const role = "Async human-in-the-loop. Per-approval VOs suspend on awakeables; per-group indexes surface them.";
  const KNOWN_GROUPS = ["ops-managers", "finance-leads"];
  const lists = await Promise.all(
    KNOWN_GROUPS.map(async (g) => ({
      group: g,
      items: (await tryFetchJSON<PendingApprovalSummary[]>(`${RESTATE_INGRESS}/PendingApprovalsIndex/${g}/list`)) ?? [],
    }))
  );
  const total = lists.reduce((n, l) => n + l.items.length, 0);
  const body =
    total === 0
      ? `<div class="empty">No pending approvals.</div>`
      : lists
          .map((l) => {
            if (l.items.length === 0) {
              return `<div class="muted" style="margin-bottom:8px"><code>${l.group}</code>: none</div>`;
            }
            const rows = l.items
              .map(
                (it) => `<tr>
                  <td>${it.kind === "appeal" ? '<span class="chip" style="background:#f55b35;color:#fff">APPEAL</span>' : '<span class="chip">approval</span>'}</td>
                  <td><span class="chip">${escapeHtml(it.toolName)}</span></td>
                  <td>${escapeHtml(it.actionSummary)}</td>
                  <td class="muted">${escapeHtml(it.initiator.userId)} · ${escapeHtml(it.initiator.sessionId)}</td>
                  <td class="muted">${new Date(it.createdAtMs).toLocaleTimeString()}</td>
                </tr>`
              )
              .join("");
            return `<div style="margin-bottom:12px">
              <div class="muted" style="margin-bottom:4px"><code>${l.group}</code> · ${l.items.length} pending</div>
              <table>
                <thead><tr><th>kind</th><th>tool</th><th>summary</th><th>from</th><th>at</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>`;
          })
          .join("");
  return (
    pageHeader("approval-service", role) +
    section("Pending across groups", body) +
    section(
      "Service info",
      `<table>
        <tr><td class="muted">restate port</td><td><code>:9085</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>ApprovalService, PendingApprovalsIndex, DecidedApprovalsIndex</code></td></tr>
        <tr><td class="muted">live approver UI</td><td><a href="/approver">/approver</a></td></tr>
      </table>`
    )
  );
}

// ---- llm-svc page ------------------------------------------------------

interface PurposeSnapshot {
  purpose: string;
  count: number;
  lastAt: number | null;
  lastCostCents: number | null;
}

async function renderLlmSvcPage(): Promise<string> {
  const role = "Single backend for every LLM call in DashOps. Gateway-routed; guardrails, rate limits, and cost tracking apply uniformly across agent planning, PII classification, and semantic search.";
  const [counters, mode] = await Promise.all([
    tryFetchJSON<PurposeSnapshot[]>(`${RESTATE_INGRESS}/LLMService/purposeCounters`),
    tryFetchJSON<{ live: boolean }>(`${RESTATE_INGRESS}/LLMService/mode`),
  ]);
  const modeBody = `<table>
    <tr><td class="muted">live mode</td><td><code>${mode === null ? "?" : mode.live ? "ON" : "off"}</code></td></tr>
    <tr><td class="muted">env trigger</td><td><code>ANTHROPIC_API_KEY</code></td></tr>
    <tr><td class="muted">fallback</td><td>deterministic stubs (see <code>services/llm-svc/src/stubs.ts</code>)</td></tr>
  </table>`;
  const countersBody = counters
    ? `<table>
        <thead><tr><th>purpose</th><th>invocations</th><th>last call</th><th>last cost</th></tr></thead>
        <tbody>${counters
          .map(
            (p) => `<tr>
              <td><span class="chip">${escapeHtml(p.purpose)}</span></td>
              <td class="counter">${p.count}</td>
              <td class="muted">${p.lastAt ? new Date(p.lastAt).toLocaleTimeString() : "—"}</td>
              <td class="muted">${p.lastCostCents != null ? p.lastCostCents + "¢" : "—"}</td>
            </tr>`
          )
          .join("")}</tbody>
      </table>`
    : `<div class="empty">Service down — couldn't read counters.</div>`;
  return (
    pageHeader("llm-svc", role) +
    section("Mode", modeBody) +
    section("Calls by purpose", countersBody) +
    section(
      "Service info",
      `<table>
        <tr><td class="muted">restate port</td><td><code>:9087</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>LLMService</code></td></tr>
        <tr><td class="muted">callers (via gateway)</td><td>ops-agent · PIIGuardrail · SemanticSearch</td></tr>
      </table>`
    )
  );
}

// Shared shell + topnav + section styling. Each /ops/<svc> page slots its
// body into this. Keeping the styles inline (rather than a stylesheet) so
// the BFF is the only thing serving HTML in the demo.
function renderOpsShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} · ops view</title>
<meta http-equiv="refresh" content="3" />
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
.container { max-width: 880px; margin: 0 auto; padding: 24px; }
h1 { color: var(--accent); margin: 0 0 4px 0; font-size: 24px; }
.role { color: var(--muted); font-size: 14px; margin-bottom: 24px; }
h2 { margin: 0 0 12px 0; font-size: 14px; text-transform: uppercase;
  letter-spacing: 1px; color: var(--muted); font-weight: 600; }
.card { background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 8px 14px 8px 0; text-align: left; font-size: 13px; }
th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
td { border-bottom: 1px solid #2a2a2a; }
.chip { background: var(--chip); color: var(--chip-fg); font-size: 11px;
  padding: 2px 8px; border-radius: 3px; font-family: ui-monospace, monospace; }
.counter { font-family: ui-monospace, monospace; color: var(--chip-fg); font-weight: 600; }
.muted { color: var(--muted); }
.empty { color: var(--muted); font-style: italic; font-size: 13px; }
code { font-family: ui-monospace, monospace; font-size: 12px; color: var(--chip-fg); }
a { color: var(--accent); }
</style>
</head>
<body>
<div class="topnav">
  <a href="/operator">operator</a>
  <a href="/approver">approver</a>
  <a href="/services">services</a>
</div>
<div class="container">
  ${body}
</div>
</body>
</html>`;
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
  return renderPortalHtml(cards);
}

function renderPortalHtml(cards: string): string {
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
</div>
<div class="container">
  <h1>DashOps services</h1>
  <div class="subtitle">Every service is independently observable. Click into one to see its state.</div>
  <div class="grid">${cards}</div>
</div>
</body>
</html>`;
}

// ---- HTTP server bootstrap -------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const handled = await dispatch(req, res, WEB_ROOT);
    if (!handled) {
      res.statusCode = 404;
      res.end("not found");
    }
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

server.listen(PORT, () => {
  console.log(`BFF listening on http://localhost:${PORT}`);
  console.log(`  operator : http://localhost:${PORT}/operator`);
  console.log(`  approver : http://localhost:${PORT}/approver`);
  console.log(`  services : http://localhost:${PORT}/services`);
});

// Clean shutdown so the supervisor can stop us gracefully.
function shutdown(signal: string) {
  console.log(`BFF: received ${signal}, closing server`);
  server.close(() => process.exit(0));
  // hard kill if close hangs (shouldn't, but just in case)
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
