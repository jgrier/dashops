import * as restate from "@restatedev/restate-sdk";
import { serveOpsView } from "@dashops/shared";
import { piiGuardrail } from "./pii.js";

const port = parseInt(process.env.PORT ?? "9084", 10);
const uiPort = parseInt(process.env.UI_PORT ?? String(port + 100), 10);

restate.serve({ services: [piiGuardrail], port });
console.log(`Guardrails (PIIGuardrail) listening on :${port}`);

serveOpsView({
  port: uiPort,
  serviceName: "guardrails",
  role: "Outbound safety checks called from gateway middlewares. Stub regex pre-screen today; LLM classifier in live mode.",
  sections: [
    {
      title: "Active guardrails",
      render: () => `<table>
        <thead><tr><th>guardrail</th><th>kind</th><th>mode</th></tr></thead>
        <tbody>
          <tr>
            <td><span class="chip">PIIGuardrail</span></td>
            <td>regex pre-screen</td>
            <td class="muted">stub (phone, ssn, credit-card patterns)</td>
          </tr>
        </tbody>
      </table>`,
    },
    {
      title: "How it's wired",
      render: () => `<div class="muted" style="font-size:13px; line-height:1.6">
        Called by <code>gateway/src/middlewares/pii-guardrail.ts</code> on every outbound tool call.
        On flag, returns <code>block_appealable</code> so the operator can escalate via <code>ops-managers</code>.
        See <a href="http://localhost:9180">gateway ops view</a> for chain order.
      </div>`,
    },
    {
      title: "Service info",
      render: () => `<table>
        <tr><td class="muted">restate port</td><td><code>:${port}</code></td></tr>
        <tr><td class="muted">ops view port</td><td><code>:${uiPort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>PIIGuardrail</code></td></tr>
      </table>`,
    },
  ],
});
