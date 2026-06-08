import * as restate from "@restatedev/restate-sdk";
import type { ToolPayload, ToolResult } from "@dashops/shared";
import { getCustomer } from "./data.js";

export const customerLookup = restate.service({
  name: "CustomerLookup",
  handlers: {
    execute: async (
      _ctx: restate.Context,
      payload: ToolPayload
    ): Promise<ToolResult> => {
      const customerId = String(payload.params.customer_id ?? "");
      const c = getCustomer(customerId);
      if (!c) {
        return {
          result: { error: `no customer found for id=${customerId}` },
          costCents: 0,
        };
      }
      return { result: c, costCents: 0 };
    },
  },
});
