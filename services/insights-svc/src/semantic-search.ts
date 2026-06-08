import * as restate from "@restatedev/restate-sdk";
import {
  bumpToolCount,
  type CallLLMRequest,
  type CallLLMResponse,
  type ToolPayload,
  type ToolResult,
} from "@dashops/shared";

// Semantic search is an LLM-backed tool: in stub mode it returns canned
// "similar complaints", in live mode it would call an embedding-based
// retrieval LLM. Either way the call routes through gateway.callLLM, which
// records the cost against the caller's tenant — so this tool now returns
// costCents=0 to its caller, since the LLM-side cost was already charged.
export const semanticSearch = restate.service({
  name: "SemanticSearch",
  handlers: {
    execute: async (
      ctx: restate.Context,
      payload: ToolPayload
    ): Promise<ToolResult> => {
      bumpToolCount("semantic_search");
      const query = String(payload.params.query ?? "");

      const llmReq: CallLLMRequest = {
        purpose: "semantic-search",
        params: { query },
        identity: payload.identity,
      };
      const resp = await ctx.genericCall<CallLLMRequest, CallLLMResponse>({
        service: "Gateway",
        method: "callLLM",
        parameter: llmReq,
        name: "gateway → llm:semantic-search",
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
      });

      return { result: resp.content, costCents: 0 };
    },
  },
});
