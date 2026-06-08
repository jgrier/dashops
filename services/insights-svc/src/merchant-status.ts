import * as restate from "@restatedev/restate-sdk";
import type { ToolPayload, ToolResult } from "@dashops/shared";

// Mock merchant status. Tightly rate-limited at the gateway (6/min in
// the registry) to drive Scene 4 — agent triggers many calls, watches
// later ones queue via durable sleep at the gateway.
export const merchantStatus = restate.service({
  name: "MerchantStatus",
  handlers: {
    execute: async (
      _ctx: restate.Context,
      payload: ToolPayload
    ): Promise<ToolResult> => {
      const merchantId = String(payload.params.merchant_id ?? "");
      const statuses: Record<string, unknown> = {
        "M-44": { open: true, kitchenLagMin: 18, lastOrderAt: "2026-06-04T19:42:00Z" },
        "M-08": { open: true, kitchenLagMin: 6,  lastOrderAt: "2026-06-04T19:31:00Z" },
        "M-21": { open: false, kitchenLagMin: 0, closedReason: "after-hours" },
      };
      const status = statuses[merchantId] ?? { error: `unknown merchant ${merchantId}` };
      return { result: { merchantId, ...((status as object) ?? {}) }, costCents: 0 };
    },
  },
});
