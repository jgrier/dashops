import * as restate from "@restatedev/restate-sdk";
import { serveOpsView, type ToolRegistration } from "@dashops/shared";
import { gateway } from "./gateway.js";
import { toolRegistry } from "./tool-registry.js";
import { costLedger } from "./cost-ledger.js";
import { tokenBucket } from "./token-bucket.js";
import { gatewayMiddlewares } from "./middlewares/index.js";
import { recentCalls } from "./calls-log.js";

const port = parseInt(process.env.PORT ?? "9080", 10);
const uiPort = parseInt(process.env.UI_PORT ?? String(port + 100), 10);
const ingress = process.env.RESTATE_INGRESS ?? "http://localhost:8080";
const adminUi = process.env.RESTATE_ADMIN_UI ?? "http://localhost:9070";

// Tenants we know about in the demo. Used to enumerate CostLedger /
// TokenBucket VOs for the ops view. Add to this list if you introduce a
// new tenant id in code.
const KNOWN_TENANTS = ["demo-tenant", "platform"];

restate.serve({
  services: [gateway, toolRegistry, costLedger, tokenBucket],
  port,
});
console.log(`Gateway (with ToolRegistry, CostLedger, TokenBucket) listening on :${port}`);

function pill(c: { status: string; appealable?: boolean; kind?: string }): string {
  if (c.status === "ok") {
    const kindMark = c.kind === "llm"
      ? ` <span style="opacity:0.7;font-size:10px">llm</span>`
      : "";
    return `<span class="chip" style="background:#1f3a1f;color:#9ce19c">ok${kindMark}</span>`;
  }
  if (c.status === "needs_approval") {
    return `<span class="chip" style="background:#3a2a05;color:#ffd28e">needs_approval</span>`;
  }
  if (c.appealable) {
    return `<span class="chip" style="background:#3a1f1f;color:#ffb0a0">blocked · appealable</span>`;
  }
  return `<span class="chip" style="background:#3a1f1f;color:#ffb0a0">blocked</span>`;
}

async function fetchRegistry(): Promise<ToolRegistration[]> {
  try {
    const r = await fetch(`${ingress}/ToolRegistry/default/list`, { method: "POST" });
    if (!r.ok) return [];
    return (await r.json()) as ToolRegistration[];
  } catch {
    return [];
  }
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

async function fetchCostSummary(tenantId: string): Promise<CostSummary | null> {
  try {
    const r = await fetch(`${ingress}/CostLedger/${encodeURIComponent(tenantId)}/summary`, {
      method: "POST",
    });
    if (!r.ok) return null;
    return (await r.json()) as CostSummary;
  } catch {
    return null;
  }
}

interface BucketState {
  key: string;
  tokens: number | null;
  lastRefillMs: number | null;
}

async function fetchBucketState(bucketKey: string): Promise<BucketState | null> {
  try {
    const r = await fetch(`${ingress}/TokenBucket/${encodeURIComponent(bucketKey)}/state`, {
      method: "POST",
    });
    if (!r.ok) return null;
    return (await r.json()) as BucketState;
  } catch {
    return null;
  }
}

// Horizontal bar showing tokens / capacity. The color shifts toward red as
// the bucket drains so the rate-limit demo has a strong visual signal.
function fillBar(tokens: number | null, capacity: number): string {
  const t = tokens ?? capacity;
  const pct = Math.max(0, Math.min(100, (t / capacity) * 100));
  const color = pct > 60 ? "#4dd478" : pct > 25 ? "#ffcc4d" : "#f55b35";
  return `<div style="display:inline-block;width:120px;height:8px;background:#2a2a2a;border-radius:4px;overflow:hidden;vertical-align:middle">
    <div style="width:${pct}%;height:100%;background:${color};transition:width 0.3s"></div>
  </div>`;
}

serveOpsView({
  port: uiPort,
  serviceName: "gateway",
  role: "Every agent ↔ tool/LLM call passes through here: registry lookup → middleware chain → dispatch → cost + audit. State below is read live from the durable VOs.",
  sections: [
    {
      title: "Middleware chain",
      render: () => {
        const rows = gatewayMiddlewares
          .map(
            (mw, i) => `<tr>
              <td class="muted">${i + 1}</td>
              <td><span class="chip">${mw.name}</span></td>
            </tr>`
          )
          .join("");
        return `<table><thead><tr><th>order</th><th>middleware</th></tr></thead>
          <tbody>${rows}</tbody></table>`;
      },
    },
    {
      title: "Tool registry",
      render: async () => {
        const tools = await fetchRegistry();
        if (tools.length === 0) {
          return `<div class="empty">No tools registered (or registry unreachable).</div>`;
        }
        const rows = tools
          .map(
            (t) => `<tr>
              <td><span class="chip">${t.name}</span></td>
              <td><code>${t.serviceName}</code></td>
              <td class="muted">${t.rateLimit?.perMinute ?? "—"}/min</td>
              <td class="muted">${t.configuredCostCents}¢</td>
              <td class="muted">${t.description}</td>
            </tr>`
          )
          .join("");
        return `<table>
          <thead><tr><th>tool</th><th>impl</th><th>rate</th><th>cost</th><th>description</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      },
    },
    {
      title: "Rate-limit buckets (live, durable in Restate)",
      render: async () => {
        // For each registered tool, peek the (demo-tenant, tool) bucket —
        // that's the per-(tenant,tool) bucket driven by the tool's
        // registered perMinute. It's where the rate-limit demo's
        // bottleneck lives (merchant_status caps at 6/min).
        const tools = await fetchRegistry();
        if (tools.length === 0) return `<div class="empty">No tools yet.</div>`;

        const rows = await Promise.all(
          tools.map(async (t) => {
            const cap = t.rateLimit?.perMinute ?? 60;
            const key = `tenant_tool:demo-tenant:${t.name}`;
            const st = await fetchBucketState(key);
            const tokens = st?.tokens ?? cap;
            const lastRefill = st?.lastRefillMs
              ? new Date(st.lastRefillMs).toLocaleTimeString()
              : "—";
            return `<tr>
              <td><span class="chip">${t.name}</span></td>
              <td>${fillBar(tokens, cap)}</td>
              <td class="counter">${tokens.toFixed(1)} / ${cap}</td>
              <td class="muted">${cap}/min</td>
              <td class="muted">${lastRefill}</td>
            </tr>`;
          })
        );
        return `<table>
          <thead><tr><th>tool</th><th>fill</th><th>tokens</th><th>capacity</th><th>last refill</th></tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
        <div class="muted" style="font-size:12px;margin-top:8px">
          Showing the <code>tenant_tool:demo-tenant:&lt;tool&gt;</code> bucket per tool — the per-(tenant,tool) limit driven by each tool's registered perMinute. When a bucket drains, the gateway's rate-limit middleware durably sleeps the call via <code>ctx.sleep</code> until a token refills.
        </div>`;
      },
    },
    {
      title: "Cost ledger (live, durable in Restate)",
      render: async () => {
        const summaries = await Promise.all(KNOWN_TENANTS.map(fetchCostSummary));
        const populated = summaries.filter((s): s is CostSummary => !!s && (s.totalCents > 0 || s.entries.length > 0));
        if (populated.length === 0) {
          return `<div class="empty">No cost recorded yet.</div>`;
        }
        return populated
          .map((s) => {
            // aggregate per toolName
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
                  <td><span class="chip">${tool}</span></td>
                  <td class="muted">${v.count}</td>
                  <td class="counter">${v.cents}¢</td>
                </tr>`
              )
              .join("");

            const recent = s.entries
              .slice(-10)
              .reverse()
              .map(
                (e) => `<tr>
                  <td class="muted">${new Date(e.timestampMs).toLocaleTimeString()}</td>
                  <td><span class="chip">${e.toolName}</span></td>
                  <td class="counter">${e.costCents}¢</td>
                  <td class="muted">${e.sessionId}</td>
                </tr>`
              )
              .join("");

            return `<div style="margin-bottom:18px">
              <div style="font-size:13px;margin-bottom:8px">
                <strong>Tenant <code>${s.tenantId}</code></strong> · total spend
                <span class="counter">${s.totalCents}¢</span>
                (${(s.totalCents / 100).toFixed(2)} USD)
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:12px">
                <div>
                  <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">by tool/purpose</div>
                  <table><tbody>${aggRows}</tbody></table>
                </div>
                <div>
                  <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">last ${Math.min(10, s.entries.length)} entries</div>
                  <table><tbody>${recent}</tbody></table>
                </div>
              </div>
            </div>`;
          })
          .join("");
      },
    },
    {
      title: "Recent calls",
      render: () => {
        const calls = recentCalls();
        if (calls.length === 0) {
          return `<div class="empty">No calls yet — fire something from the operator UI.</div>`;
        }
        const rows = calls
          .map((c) => {
            const statusPill = pill(c);
            const detail = [c.source ? `<code>${c.source}</code>` : null, c.reason]
              .filter(Boolean)
              .join(" — ");
            const waited = c.waitedMs ? ` <span class="muted">(+${c.waitedMs}ms rate-wait)</span>` : "";
            const cost = c.costCents ? ` <span class="muted">${c.costCents}¢</span>` : "";
            const time = c.invocationId
              ? `<a href="${adminUi}/ui/invocations/${encodeURIComponent(c.invocationId)}"
                    target="_blank" class="muted"
                    title="open in Restate admin">${new Date(c.timestampMs).toLocaleTimeString()} ↗</a>`
              : `<span class="muted">${new Date(c.timestampMs).toLocaleTimeString()}</span>`;
            return `<tr>
              <td>${time}</td>
              <td><span class="chip">${c.toolName}</span></td>
              <td>${statusPill}</td>
              <td>${detail}${waited}${cost}</td>
            </tr>`;
          })
          .join("");
        return `<table>
          <thead><tr><th>time</th><th>tool</th><th>outcome</th><th>detail</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="muted" style="font-size:12px;margin-top:8px">
          Click a timestamp to open the invocation's journal in the Restate admin UI.
        </div>`;
      },
    },
    {
      title: "Service info",
      render: () => `<table>
        <tr><td class="muted">restate port</td><td><code>:${port}</code></td></tr>
        <tr><td class="muted">ops view port</td><td><code>:${uiPort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>Gateway</code>, <code>ToolRegistry</code>, <code>CostLedger</code>, <code>TokenBucket</code></td></tr>
        <tr><td class="muted">admin UI</td><td><a href="${adminUi}/ui/" target="_blank">${adminUi}/ui/</a></td></tr>
      </table>`,
    },
  ],
});
