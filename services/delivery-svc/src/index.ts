import * as restate from "@restatedev/restate-sdk";
import { selfRegisterTools, serveOpsView, readToolCounters } from "@dashops/shared";
import { deliveryLookup } from "./delivery-lookup.js";
import { escalationHistory } from "./escalation-history.js";

const port = parseInt(process.env.PORT ?? "9081", 10);
const uiPort = parseInt(process.env.UI_PORT ?? String(port + 100), 10);

restate.serve({
  services: [deliveryLookup, escalationHistory],
  port,
});
console.log(`delivery-svc listening on :${port}`);

const ownedTools = ["delivery_lookup", "escalation_history"];

serveOpsView({
  port: uiPort,
  serviceName: "delivery-svc",
  role: "Delivery-domain reads: lookups by delivery ID and escalation history.",
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
      title: "Service info",
      render: () => `<table>
        <tr><td class="muted">restate port</td><td><code>:${port}</code></td></tr>
        <tr><td class="muted">ops view port</td><td><code>:${uiPort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>DeliveryLookup</code>, <code>EscalationHistory</code></td></tr>
      </table>`,
    },
  ],
});

// Self-register the tools we own with the gateway's ToolRegistry.
selfRegisterTools([
  {
    name: "delivery_lookup",
    serviceName: "DeliveryLookup",
    handlerName: "execute",
    description: "Look up a delivery by ID",
    configuredCostCents: 0,
    rateLimit: { perMinute: 60 },
  },
  {
    name: "escalation_history",
    serviceName: "EscalationHistory",
    handlerName: "execute",
    description: "Recent escalations for a delivery",
    configuredCostCents: 0,
    rateLimit: { perMinute: 60 },
  },
]);
