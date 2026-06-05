import * as restate from "@restatedev/restate-sdk";
import type { PendingApprovalSummary } from "@dashops/shared";

// PendingApprovalsIndex — VO keyed by approver_group. Holds a list of
// summaries for in-flight approvals so the approver UI can fetch quickly
// without scanning the Restate journal.
export const pendingApprovalsIndex = restate.object({
  name: "PendingApprovalsIndex",
  handlers: {
    add: async (
      ctx: restate.ObjectContext,
      summary: PendingApprovalSummary
    ): Promise<void> => {
      const existing = (await ctx.get<PendingApprovalSummary[]>("pending")) ?? [];
      // Dedup by approvalId
      const filtered = existing.filter((p) => p.approvalId !== summary.approvalId);
      filtered.push(summary);
      ctx.set("pending", filtered);
    },

    remove: async (
      ctx: restate.ObjectContext,
      input: { approvalId: string }
    ): Promise<void> => {
      const existing = (await ctx.get<PendingApprovalSummary[]>("pending")) ?? [];
      ctx.set("pending", existing.filter((p) => p.approvalId !== input.approvalId));
    },

    list: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<PendingApprovalSummary[]> => {
        return (await ctx.get<PendingApprovalSummary[]>("pending")) ?? [];
      }
    ),
  },
});
