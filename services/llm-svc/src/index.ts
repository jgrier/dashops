import * as restate from "@restatedev/restate-sdk";
import { serveOpsView } from "@dashops/shared";
import { llmService } from "./llm.js";
import { readPurposeCounters } from "./counters.js";

const port = parseInt(process.env.PORT ?? "9087", 10);
const uiPort = parseInt(process.env.UI_PORT ?? String(port + 100), 10);
const LIVE_MODE = !!process.env.ANTHROPIC_API_KEY;

restate.serve({ services: [llmService], port });
console.log(`llm-svc listening on :${port}  (mode=${LIVE_MODE ? "LIVE" : "stub"})`);

serveOpsView({
  port: uiPort,
  serviceName: "llm-svc",
  role: "Single backend for every LLM call in DashOps. Routes through the gateway's callLLM handler so guardrails, rate limits, and cost tracking apply uniformly to agent planning, PII classification, and semantic search.",
  sections: [
    {
      title: "Mode",
      render: () => `<table>
        <tr><td class="muted">live mode</td><td><code>${LIVE_MODE ? "ON" : "off"}</code></td></tr>
        <tr><td class="muted">env trigger</td><td><code>ANTHROPIC_API_KEY</code></td></tr>
        <tr><td class="muted">fallback</td><td>deterministic stubs (see <code>src/stubs.ts</code>)</td></tr>
      </table>`,
    },
    {
      title: "Calls by purpose",
      render: () => {
        const rows = readPurposeCounters()
          .map(
            (p) => `<tr>
              <td><span class="chip">${p.purpose}</span></td>
              <td class="counter">${p.count}</td>
              <td class="muted">${p.lastAt ? new Date(p.lastAt).toLocaleTimeString() : "—"}</td>
              <td class="muted">${p.lastCostCents != null ? p.lastCostCents + "¢" : "—"}</td>
            </tr>`
          )
          .join("");
        return `<table>
          <thead><tr><th>purpose</th><th>invocations</th><th>last call</th><th>last cost</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      },
    },
    {
      title: "Service info",
      render: () => `<table>
        <tr><td class="muted">restate port</td><td><code>:${port}</code></td></tr>
        <tr><td class="muted">ops view port</td><td><code>:${uiPort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>LLMService</code></td></tr>
        <tr><td class="muted">callers (via gateway)</td><td>ops-agent · PIIGuardrail · SemanticSearch</td></tr>
      </table>`,
    },
  ],
});
