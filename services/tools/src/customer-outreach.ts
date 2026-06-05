import * as restate from "@restatedev/restate-sdk";
import type { ToolPayload, ToolResult } from "@dashops/shared";

// Action tool. Approval-gated by gateway policy when the template is in the
// sensitive set (apology_with_credit, refund_offer).
export const customerOutreach = restate.service({
  name: "CustomerOutreach",
  handlers: {
    execute: async (
      ctx: restate.Context,
      payload: ToolPayload
    ): Promise<ToolResult> => {
      const customerId = String(payload.params.customer_id ?? "");
      const template = String(payload.params.template ?? "");
      const templateParams = (payload.params.template_params as Record<string, unknown>) ?? {};

      const sent = await ctx.run("send outreach message", () => ({
        sent: true,
        customerId,
        template,
        templateParams,
        sentAtMs: Date.now(),
        messageId: "msg-" + Math.random().toString(36).slice(2, 10),
      }));

      return { result: sent, costCents: 0 };
    },
  },
});
