import * as restate from "@restatedev/restate-sdk";
import { serveOpsView, type PendingApprovalSummary } from "@dashops/shared";
import { approvalService } from "./approval.js";
import { pendingApprovalsIndex } from "./pending-index.js";

const port = parseInt(process.env.PORT ?? "9085", 10);
const uiPort = parseInt(process.env.UI_PORT ?? String(port + 100), 10);
const ingress = process.env.RESTATE_INGRESS ?? "http://localhost:8080";

restate.serve({ services: [approvalService, pendingApprovalsIndex], port });
console.log(`Approval-service (ApprovalService, PendingApprovalsIndex) listening on :${port}`);

// The two approver groups the demo uses. Add new ones here as policies grow.
const KNOWN_GROUPS = ["ops-managers", "finance-leads"];

async function fetchPending(group: string): Promise<PendingApprovalSummary[]> {
  try {
    const r = await fetch(`${ingress}/PendingApprovalsIndex/${group}/list`, {
      method: "POST",
    });
    if (!r.ok) return [];
    return (await r.json()) as PendingApprovalSummary[];
  } catch {
    return [];
  }
}

serveOpsView({
  port: uiPort,
  serviceName: "approval-service",
  role: "Async human-in-the-loop. ApprovalService keyed-VOs suspend on awakeables until approver UI decides; PendingApprovalsIndex VOs surface them per group.",
  sections: [
    {
      title: "Pending across groups",
      render: async () => {
        const groups = await Promise.all(
          KNOWN_GROUPS.map(async (g) => ({ group: g, items: await fetchPending(g) }))
        );
        const total = groups.reduce((n, g) => n + g.items.length, 0);
        if (total === 0) {
          return `<div class="empty">No pending approvals.</div>`;
        }
        return groups
          .map((g) => {
            if (g.items.length === 0) {
              return `<div class="muted" style="margin-bottom:8px"><code>${g.group}</code>: none</div>`;
            }
            const rows = g.items
              .map(
                (it) => `<tr>
                  <td>${it.kind === "appeal" ? '<span class="chip" style="background:#f55b35;color:#fff">APPEAL</span>' : '<span class="chip">approval</span>'}</td>
                  <td><span class="chip">${it.toolName}</span></td>
                  <td>${it.actionSummary}</td>
                  <td class="muted">${it.initiator.userId} · ${it.initiator.sessionId}</td>
                  <td class="muted">${new Date(it.createdAtMs).toLocaleTimeString()}</td>
                </tr>`
              )
              .join("");
            return `<div style="margin-bottom:12px">
              <div class="muted" style="margin-bottom:4px"><code>${g.group}</code> · ${g.items.length} pending</div>
              <table>
                <thead><tr><th>kind</th><th>tool</th><th>summary</th><th>from</th><th>at</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>`;
          })
          .join("");
      },
    },
    {
      title: "Service info",
      render: () => `<table>
        <tr><td class="muted">restate port</td><td><code>:${port}</code></td></tr>
        <tr><td class="muted">ops view port</td><td><code>:${uiPort}</code></td></tr>
        <tr><td class="muted">restate services</td><td><code>ApprovalService</code>, <code>PendingApprovalsIndex</code></td></tr>
        <tr><td class="muted">known groups</td><td><code>${KNOWN_GROUPS.join("</code>, <code>")}</code></td></tr>
        <tr><td class="muted">live approver UI</td><td><a href="http://localhost:3000/approver">http://localhost:3000/approver</a></td></tr>
      </table>`,
    },
  ],
});
