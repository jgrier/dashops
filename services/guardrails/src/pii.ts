import * as restate from "@restatedev/restate-sdk";
import type { CallLLMRequest, CallLLMResponse, CallerIdentity } from "@dashops/shared";

// PII guardrail: inspects the JSON-serialized params of a pending tool call
// and flags if PII patterns are detected. Today the implementation is a
// regex pre-screen; tomorrow (ANTHROPIC_API_KEY set) it's an LLM classifier.
// Either way the call routes through the gateway's callLLM handler, so
// cost, audit logging, and future rate-limit/prompt-redaction concerns are
// all applied at one place.

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

// Caller identity for the LLM call. The guardrail isn't a per-tenant actor
// (it's the platform inspecting an outbound call), so we use a synthetic
// platform identity. The original tool call's tenant is what matters for
// cost accounting, but cost is recorded by the gateway against this
// guardrail's identity — fine for now since cost on the regex stub is 0.
const PLATFORM_IDENTITY: CallerIdentity = {
  tenantId: "platform",
  userId: "platform:guardrails",
  agentId: "pii-guardrail",
  sessionId: "pii-guardrail",
  traceId: "guardrail",
};

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
