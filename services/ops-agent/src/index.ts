import * as restate from "@restatedev/restate-sdk";
import { serveOpsView } from "@dashops/shared";
import { session } from "./session.js";
import { startWebBridge } from "./web.js";

const port = parseInt(process.env.PORT ?? "9083", 10);
const webPort = parseInt(process.env.WEB_PORT ?? "3000", 10);
const uiPort = parseInt(process.env.UI_PORT ?? String(port + 100), 10);

restate.serve({ services: [session], port });
console.log(`Ops-agent (Session VO) listening on :${port}`);

startWebBridge(webPort);

serveOpsView({
  port: uiPort,
  serviceName: "ops-agent",
  role: "Per-session VOs that drive a fake LLM loop, call tools through the gateway, and suspend on approvals/appeals.",
  sections: [
    {
      title: "Statuses a Session moves through",
      render: () => `<table>
        <thead><tr><th>status</th><th>meaning</th></tr></thead>
        <tbody>
          <tr><td><span class="chip">idle</span></td><td class="muted">no active turn</td></tr>
          <tr><td><span class="chip">thinking</span></td><td class="muted">running the planner / fake LLM</td></tr>
          <tr><td><span class="chip">calling_tool</span></td><td class="muted">awaiting a Gateway.callTool</td></tr>
          <tr><td><span class="chip">needs_approval</span></td><td class="muted">suspended on an awakeable; an approver must decide</td></tr>
          <tr><td><span class="chip">blocked_appealable</span></td><td class="muted">guardrail blocked; operator may escalate (commit 2)</td></tr>
          <tr><td><span class="chip">appeal_pending</span></td><td class="muted">suspended awaiting an appeal decision</td></tr>
          <tr><td><span class="chip">complete</span></td><td class="muted">turn finished</td></tr>
          <tr><td><span class="chip">failed</span></td><td class="muted">unrecoverable</td></tr>
        </tbody>
      </table>`,
    },
    {
      title: "Live chat surfaces",
      render: () => `<table>
        <tr><td class="muted">operator UI</td><td><a href="http://localhost:3000/operator">http://localhost:3000/operator</a></td></tr>
        <tr><td class="muted">approver UI</td><td><a href="http://localhost:3000/approver">http://localhost:3000/approver</a></td></tr>
      </table>`,
    },
    {
      title: "Service info",
      render: () => `<table>
        <tr><td class="muted">restate port</td><td><code>:${port}</code></td></tr>
        <tr><td class="muted">web bridge port</td><td><code>:${webPort}</code></td></tr>
        <tr><td class="muted">ops view port</td><td><code>:${uiPort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>Session</code></td></tr>
      </table>`,
    },
  ],
});
