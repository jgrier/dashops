import * as restate from "@restatedev/restate-sdk";
import type { CallerIdentity } from "@dashops/shared";
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

    // Pass the original tool caller's identity through so the underlying
    // gateway.callLLM that PIIGuardrail.check makes bills the right tenant.
    // The middleware itself no longer records a separate cost entry —
    // callLLM is the single source of LLM cost in the ledger now.
    const resp = await ctx.genericCall<
      { params: Record<string, unknown>; toolName: string; identity: CallerIdentity },
      PIIResp
    >({
      service: "PIIGuardrail",
      method: "check",
      parameter: { params: req.params, toolName: req.toolName, identity: req.identity },
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
