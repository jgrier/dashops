import * as restate from "@restatedev/restate-sdk";
import type { DecidedApprovalSummary } from "@dashops/shared";

// Per-approver-group audit log. ApprovalService fire-and-forgets a summary
// into here on every respond/cancel so the approver UI's history tab and
// any compliance/audit tooling can replay the decision stream without
// having to enumerate per-approval VOs.

const MAX_PER_GROUP = 200;

export const decidedApprovalsIndex = restate.object({
  name: "DecidedApprovalsIndex",
  handlers: {
    add: async (
      ctx: restate.ObjectContext,
      entry: DecidedApprovalSummary
    ): Promise<{ ok: true }> => {
      const list = (await ctx.get<DecidedApprovalSummary[]>("entries")) ?? [];
      list.push(entry);
      // Trim the oldest entries; demo state, not durable analytics warehouse.
      ctx.set("entries", list.slice(-MAX_PER_GROUP));
      return { ok: true };
    },

    list: restate.handlers.object.shared(
      async (
        ctx: restate.ObjectSharedContext
      ): Promise<DecidedApprovalSummary[]> => {
        return ((await ctx.get<DecidedApprovalSummary[]>("entries")) ?? [])
          .slice()
          .reverse();   // newest first
      }
    ),
  },
});
