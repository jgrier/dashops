import * as restate from "@restatedev/restate-sdk";
import { bumpToolCount, type ToolPayload, type ToolResult } from "@dashops/shared";
import { getEscalations } from "./data.js";

export const escalationHistory = restate.service({
  name: "EscalationHistory",
  handlers: {
    execute: async (
      _ctx: restate.Context,
      payload: ToolPayload
    ): Promise<ToolResult> => {
      bumpToolCount("escalation_history");
      const deliveryId = String(payload.params.delivery_id ?? "");
      const escalations = getEscalations(deliveryId);
      const lastSatisfaction = escalations.at(-1)?.satisfaction ?? null;
      const unsatisfiedSignal =
        lastSatisfaction !== null && lastSatisfaction <= 2;
      return {
        result: {
          deliveryId,
          escalations,
          summary: {
            count: escalations.length,
            lastSatisfaction,
            unsatisfiedSignal,
          },
        },
        costCents: 0,
      };
    },
  },
});
