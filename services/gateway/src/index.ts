import * as restate from "@restatedev/restate-sdk";
import { serveOpsView, type ToolRegistration } from "@dashops/shared";
import { gateway } from "./gateway.js";
import { toolRegistry } from "./tool-registry.js";
import { costLedger } from "./cost-ledger.js";
import { tokenBucket } from "./token-bucket.js";
import { gatewayMiddlewares } from "./middlewares/index.js";

const port = parseInt(process.env.PORT ?? "9080", 10);
const uiPort = parseInt(process.env.UI_PORT ?? String(port + 100), 10);
const ingress = process.env.RESTATE_INGRESS ?? "http://localhost:8080";

restate.serve({
  services: [gateway, toolRegistry, costLedger, tokenBucket],
  port,
});
console.log(`Gateway (with ToolRegistry, CostLedger, TokenBucket) listening on :${port}`);

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
      title: "Service info",
      render: () => `<table>
        <tr><td class="muted">restate port</td><td><code>:${port}</code></td></tr>
        <tr><td class="muted">ops view port</td><td><code>:${uiPort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>Gateway</code>, <code>ToolRegistry</code>, <code>CostLedger</code>, <code>TokenBucket</code></td></tr>
      </table>`,
    },
  ],
});
