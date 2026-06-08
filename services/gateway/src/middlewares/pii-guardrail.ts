import * as restate from "@restatedev/restate-sdk";
import type { Middleware, MiddlewareResult, MiddlewareContext } from "./types.js";

type PIIResp = {
  flagged: boolean;
  reason?: string;
  detected?: unknown;
  costCents: number;
};

// Inspects outbound tool params for PII patterns by calling the PIIGuardrail
// service. On a flag, returns block_appealable so the operator can escalate
// the call to a human reviewer (ops-managers) when the heuristic is wrong.
export const piiGuardrailMW: Middleware = {
  name: "pii-guardrail",
  async check(
    ctx: restate.Context,
    mctx: MiddlewareContext
  ): Promise<MiddlewareResult> {
    const req = mctx.request;

    // PIIGuardrail.check makes its own gateway.callLLM internally, billing
    // the "platform" tenant for the cross-cutting safety check (see
    // PLATFORM_IDENTITY in shared). The middleware itself no longer
    // writes a CostLedger entry — callLLM is the single source.
    const resp = await ctx.genericCall<
      { params: Record<string, unknown>; toolName: string; parentTraceId: string },
      PIIResp
    >({
      service: "PIIGuardrail",
      method: "check",
      parameter: {
        params: req.params,
        toolName: req.toolName,
        // Propagate the originating turn's trace id so the guardrail's
        // own LLM call groups with the rest of the turn, even though
        // its cost attributes to the platform tenant.
        parentTraceId: req.identity.traceId,
      },
      inputSerde: restate.serde.json,
      outputSerde: restate.serde.json,
      name: "mw · pii-guardrail",
    });

    if (!resp.flagged) return { kind: "pass" };

    return {
      kind: "block_appealable",
      source: "pii-guardrail",
      reason: resp.reason ?? "PII detected in tool params",
      details: resp.detected,
      appeal: {
        approverGroup: "ops-managers",
        summaryHint: `Allow ${req.toolName} call despite PII guardrail flag?`,
      },
    };
  },
};
