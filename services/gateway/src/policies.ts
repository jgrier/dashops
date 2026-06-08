// Gateway policy registry: which tool calls require human approval, and which
// approver group should make the decision. Lives next to the gateway because
// approval is a *gateway concern*, not a tool concern (per OA-D1/OA-D5 in the
// design doc).

export interface ApprovalPolicy {
  // Returns true if THIS call (with these params) needs approval.
  condition: (params: Record<string, unknown>) => boolean;
  // Group of approvers responsible for this kind of action.
  approverGroup: string;
  // One-line human-readable summary for the approver UI.
  summary: (params: Record<string, unknown>) => string;
}

// Approval policies are intentionally narrow today: only the actually-financial
// step (apply_credit > $10) gates on finance-leads. The follow-on
// customer_outreach used to also gate on ops-managers, but stacking two human
// approvals on a single "apologize + credit" turn was noise — the financial
// risk is the credit itself; the apology message is benign once the money has
// been blessed.
//
// ops-managers is still exercised via the PII appeal path (see
// services/gateway/src/middlewares/pii-guardrail.ts — block_appealable
// escalates to ops-managers).
export const policies: Record<string, ApprovalPolicy> = {
  apply_credit: {
    condition: (p) => Number(p.amount_cents ?? 0) > 1000,
    approverGroup: "finance-leads",
    summary: (p) =>
      `Apply $${(Number(p.amount_cents ?? 0) / 100).toFixed(2)} credit to customer ${
        p.customer_id ?? "?"
      }${p.reason ? ` — "${String(p.reason).slice(0, 60)}"` : ""}`,
  },
};

// Stable fingerprint of (toolName, params). Used to bind an approval token
// to exactly the call it was issued for (prevents approval reuse for a
// different action).
import { createHash } from "node:crypto";
export function fingerprint(
  toolName: string,
  params: Record<string, unknown>
): string {
  const canonical = JSON.stringify({ toolName, params }, Object.keys(params).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
