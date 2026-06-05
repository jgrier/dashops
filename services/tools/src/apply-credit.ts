import * as restate from "@restatedev/restate-sdk";
import type { ToolPayload, ToolResult } from "@dashops/shared";

// Action tool. Approval-gated by gateway policy (amount > $10 → finance-leads).
// Phase 5: a deliberately-buggy v1 will reject non-whole-dollar amounts to
// drive the patch-and-replay failure scenario; for Phase 3 we run "clean".
export const applyCredit = restate.service({
  name: "ApplyCredit",
  handlers: {
    execute: async (
      ctx: restate.Context,
      payload: ToolPayload
    ): Promise<ToolResult> => {
      const customerId = String(payload.params.customer_id ?? "");
      const amountCents = Number(payload.params.amount_cents ?? 0);
      const reason = String(payload.params.reason ?? "");

      // Phase 5 will toggle this on with BUGGY_MODE=1.
      if (process.env.BUGGY_MODE === "1" && amountCents % 100 !== 0) {
        throw new restate.TerminalError(
          `amount_cents must be a multiple of 100 (got ${amountCents})`,
          { errorCode: 400 }
        );
      }

      // Side-effect: pretend to apply a credit to the customer's account.
      // ctx.run journals the result so retries don't double-apply.
      const credit = await ctx.run("apply credit to customer account", () => ({
        applied: true,
        customerId,
        amountCents,
        reason,
        appliedAtMs: Date.now(),
        creditId: "credit-" + Math.random().toString(36).slice(2, 10),
      }));

      return { result: credit, costCents: 0 };
    },
  },
});
