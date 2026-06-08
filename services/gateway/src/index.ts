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

serveOpsView({
  port: uiPort,
  serviceName: "gateway",
  role: "Every agent ↔ tool call passes through here: registry lookup → middleware chain → dispatch → cost record.",
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
            return `<tr>
              <td class="muted">${new Date(c.timestampMs).toLocaleTimeString()}</td>
              <td><span class="chip">${c.toolName}</span></td>
              <td>${statusPill}</td>
              <td>${detail}${waited}${cost}</td>
            </tr>`;
          })
          .join("");
        return `<table>
          <thead><tr><th>time</th><th>tool</th><th>outcome</th><th>detail</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      },
    },
    {
      title: "Service info",
      render: () => `<table>
        <tr><td class="muted">restate port</td><td><code>:${port}</code></td></tr>
        <tr><td class="muted">ops view port</td><td><code>:${uiPort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>Gateway</code>, <code>ToolRegistry</code>, <code>CostLedger</code>, <code>TokenBucket</code></td></tr>
      </table>`,
    },
  ],
});
