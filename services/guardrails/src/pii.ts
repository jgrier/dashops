import * as restate from "@restatedev/restate-sdk";
import { PLATFORM_IDENTITY, type CallLLMRequest, type CallLLMResponse } from "@dashops/shared";

// PII guardrail: inspects the JSON-serialized params of a pending tool call
// and flags if PII patterns are detected. Today the implementation is a
// regex pre-screen; tomorrow (ANTHROPIC_API_KEY set) it's an LLM classifier.
// Either way the call routes through the gateway's callLLM handler.
//
// Cost attribution: this is a cross-cutting platform concern, not something
// the tenant asked for. The LLM call is made with PLATFORM_IDENTITY so the
// cost lands on the "platform" tenant ledger — same pattern any future
// safety guardrail (prompt-injection, content-safety) should follow.

export interface PIICheckRequest {
  params: Record<string, unknown>;
  toolName: string;
}

export interface PIICheckResponse {
  flagged: boolean;
  reason?: string;
  detected?: Array<{ kind: string; sample: string }>;
  costCents: number;
}

export const piiGuardrail = restate.service({
  name: "PIIGuardrail",
  handlers: {
    check: async (
      ctx: restate.Context,
      req: PIICheckRequest
    ): Promise<PIICheckResponse> => {
      const llmReq: CallLLMRequest = {
        purpose: "guardrail-pii",
        params: { params: req.params, toolName: req.toolName },
        identity: PLATFORM_IDENTITY,
      };
      const resp = await ctx.genericCall<CallLLMRequest, CallLLMResponse>({
        service: "Gateway",
        method: "callLLM",
        parameter: llmReq,
        name: "gateway → llm:guardrail-pii",
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
      });

      const c = (resp.content as
        | { flagged: boolean; reason?: string; detected?: Array<{ kind: string; sample: string }> }
        | undefined) ?? { flagged: false };

      return {
        flagged: c.flagged,
        reason: c.reason,
        detected: c.detected,
        costCents: resp.costCents,
      };
    },
  },
});
