import * as restate from "@restatedev/restate-sdk";
import { selfRegisterTools, serveOpsView, readToolCounters } from "@dashops/shared";
import { customerLookup } from "./customer-lookup.js";
import { applyCredit } from "./apply-credit.js";
import { customerOutreach } from "./customer-outreach.js";

const port = parseInt(process.env.PORT ?? "9082", 10);
const uiPort = parseInt(process.env.UI_PORT ?? String(port + 100), 10);

restate.serve({
  services: [customerLookup, applyCredit, customerOutreach],
  port,
});
console.log(`customer-svc listening on :${port}`);

const ownedTools = ["customer_lookup", "apply_credit", "customer_outreach"];

serveOpsView({
  port: uiPort,
  serviceName: "customer-svc",
  role: "Customer-domain reads and writes: profile lookup, credit application, outreach.",
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
        <tr><td><span class="chip">apply_credit</span></td>
            <td class="muted">Approval-gated when amount &gt; $10 → <code>finance-leads</code></td></tr>
        <tr><td><span class="chip">customer_outreach</span></td>
            <td class="muted">Approval-gated for sensitive templates; PII guardrail can block params</td></tr>
        <tr><td><span class="chip">apply_credit</span></td>
            <td class="muted">v1 has a deliberate non-whole-dollar bug under <code>BUGGY_MODE=1</code></td></tr>
      </table>`,
    },
    {
      title: "Service info",
      render: () => `<table>
        <tr><td class="muted">restate port</td><td><code>:${port}</code></td></tr>
        <tr><td class="muted">ops view port</td><td><code>:${uiPort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>CustomerLookup</code>, <code>ApplyCredit</code>, <code>CustomerOutreach</code></td></tr>
        <tr><td class="muted">buggy mode</td><td><code>${process.env.BUGGY_MODE === "1" ? "ON" : "off"}</code></td></tr>
      </table>`,
    },
  ],
});

selfRegisterTools([
  {
    name: "customer_lookup",
    serviceName: "CustomerLookup",
    handlerName: "execute",
    description: "Look up a customer profile by ID",
    configuredCostCents: 0,
    rateLimit: { perMinute: 60 },
  },
  {
    name: "apply_credit",
    serviceName: "ApplyCredit",
    handlerName: "execute",
    description: "Apply a credit to a customer",
    configuredCostCents: 0,
    rateLimit: { perMinute: 10 },
  },
  {
    name: "customer_outreach",
    serviceName: "CustomerOutreach",
    handlerName: "execute",
    description: "Send an outreach message",
    configuredCostCents: 0,
    rateLimit: { perMinute: 10 },
  },
]);
