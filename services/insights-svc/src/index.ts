import * as restate from "@restatedev/restate-sdk";
import { selfRegisterTools, serveOpsView, readToolCounters } from "@dashops/shared";
import { semanticSearch } from "./semantic-search.js";
import { merchantStatus } from "./merchant-status.js";

const port = parseInt(process.env.PORT ?? "9086", 10);
const uiPort = parseInt(process.env.UI_PORT ?? String(port + 100), 10);

restate.serve({
  services: [semanticSearch, merchantStatus],
  port,
});
console.log(`insights-svc listening on :${port}`);

const ownedTools = ["semantic_search", "merchant_status"];

serveOpsView({
  port: uiPort,
  serviceName: "insights-svc",
  role: "Analytical/external lookups: similar-complaint search and merchant status.",
  sections: [
    {
      title: "Tools served",
      render: () => {
        const snaps = readToolCounters(ownedTools);
        const rows = snaps
          .map(
            (s) => `<tr>
              <td><span class="chip">${s.name}</span></td>
              <td class="counter">${s.count}</td>
              <td class="muted">${
                s.lastInvokedAt ? new Date(s.lastInvokedAt).toLocaleTimeString() : "—"
              }</td>
            </tr>`
          )
          .join("");
        return `<table>
          <thead><tr><th>tool</th><th>invocations</th><th>last call</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      },
    },
    {
      title: "Notable behavior",
      render: () => `<table>
        <tr><td><span class="chip">semantic_search</span></td>
            <td class="muted">5¢ per call — drives the cost-ledger demo</td></tr>
        <tr><td><span class="chip">merchant_status</span></td>
            <td class="muted">Tightly rate-limited at 6/min — drives the queueing demo</td></tr>
      </table>`,
    },
    {
      title: "Service info",
      render: () => `<table>
        <tr><td class="muted">restate port</td><td><code>:${port}</code></td></tr>
        <tr><td class="muted">ops view port</td><td><code>:${uiPort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>SemanticSearch</code>, <code>MerchantStatus</code></td></tr>
      </table>`,
    },
  ],
});

selfRegisterTools([
  {
    name: "semantic_search",
    serviceName: "SemanticSearch",
    handlerName: "execute",
    description: "Find similar past complaints",
    configuredCostCents: 5,
    rateLimit: { perMinute: 30 },
  },
  {
    name: "merchant_status",
    serviceName: "MerchantStatus",
    handlerName: "execute",
    description: "Get merchant operational status",
    configuredCostCents: 0,
    rateLimit: { perMinute: 6 },
  },
]);
