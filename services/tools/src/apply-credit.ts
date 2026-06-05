import * as restate from "@restatedev/restate-sdk";
import type { ToolPayload, ToolResult } from "@dashops/shared";

// Action tool. Approval-gated by gateway policy (amount > $10 → finance-leads).
//
// Phase 5: when env BUGGY_MODE=1, the v1 implementation has a deliberate bug
// that rejects non-whole-dollar amounts. The error is RETRYABLE (plain Error,
// not TerminalError), and the service is configured with maxAttempts=3 and
// onMaxAttempts=pause — so Restate retries 3x, then pauses the invocation.
// The paused invocation is what we resume after restarting the tool with
// BUGGY_MODE off, demonstrating Stephan's pitch:
//   'take a failed invocation, inject a patch, resume from exactly that point'.
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

      if (process.env.BUGGY_MODE === "1" && amountCents % 100 !== 0) {
        // Retryable: plain Error. Restate will retry per the policy below;
        // after retries exhaust, the invocation pauses (per service options).
        throw new Error(
          `amount_cents must be a multiple of 100 (got ${amountCents})`
        );
      }

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
  options: {
    retryPolicy: {
      maxAttempts: 3,
      onMaxAttempts: "pause",
    },
  },
});
