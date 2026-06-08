import * as restate from "@restatedev/restate-sdk";
import type { ToolPayload, ToolResult } from "@dashops/shared";
import { getDelivery } from "./data.js";

export const deliveryLookup = restate.service({
  name: "DeliveryLookup",
  handlers: {
    execute: async (
      _ctx: restate.Context,
      payload: ToolPayload
    ): Promise<ToolResult> => {
      const deliveryId = String(payload.params.delivery_id ?? "");
      const d = getDelivery(deliveryId);
      if (!d) {
        return {
          result: { error: `no delivery found for id=${deliveryId}` },
          costCents: 0,
        };
      }
      return { result: d, costCents: 0 };
    },
  },
});
