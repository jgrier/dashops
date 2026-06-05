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

const SENSITIVE_OUTREACH_TEMPLATES = new Set([
  "apology_with_credit",
  "refund_offer",
]);

export const policies: Record<string, ApprovalPolicy> = {
  apply_credit: {
    condition: (p) => Number(p.amount_cents ?? 0) > 1000,
    approverGroup: "finance-leads",
    summary: (p) =>
      `Apply $${(Number(p.amount_cents ?? 0) / 100).toFixed(2)} credit to customer ${
        p.customer_id ?? "?"
      }${p.reason ? ` — "${String(p.reason).slice(0, 60)}"` : ""}`,
  },
  customer_outreach: {
    condition: (p) => SENSITIVE_OUTREACH_TEMPLATES.has(String(p.template ?? "")),
    approverGroup: "ops-managers",
    summary: (p) =>
      `Send "${p.template}" outreach to customer ${p.customer_id ?? "?"}`,
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
