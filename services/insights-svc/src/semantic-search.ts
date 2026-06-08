import * as restate from "@restatedev/restate-sdk";
import { bumpToolCount, type ToolPayload, type ToolResult } from "@dashops/shared";

// Stub semantic search. In live mode (Phase 6) this calls an LLM for real
// embedding-based similarity. For now it returns canned "similar complaints"
// and self-reports a non-zero cost so the cost ledger demo lights up.
export const semanticSearch = restate.service({
  name: "SemanticSearch",
  handlers: {
    execute: async (
      _ctx: restate.Context,
      payload: ToolPayload
    ): Promise<ToolResult> => {
      bumpToolCount("semantic_search");
      const query = String(payload.params.query ?? "");
      const results = [
        {
          deliveryId: "12101",
          summary: "cold food, refunded 25%",
          similarity: 0.82,
        },
        {
          deliveryId: "12277",
          summary: "missing items, full credit issued",
          similarity: 0.71,
        },
        {
          deliveryId: "12318",
          summary: "late delivery, customer offered loyalty points",
          similarity: 0.66,
        },
      ];
      return {
        result: { query, results, count: results.length },
        costCents: 5,
      };
    },
  },
});
