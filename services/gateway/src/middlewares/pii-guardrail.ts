import * as restate from "@restatedev/restate-sdk";
import type { Middleware, MiddlewareResult, MiddlewareContext } from "./types.js";
import type { CostEntry } from "../cost-ledger.js";

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

    const resp = await ctx.genericCall<
      { params: Record<string, unknown>; toolName: string },
      PIIResp
    >({
      service: "PIIGuardrail",
      method: "check",
      parameter: { params: req.params, toolName: req.toolName },
      inputSerde: restate.serde.json,
      outputSerde: restate.serde.json,
      name: "mw · pii-guardrail",
    });

    if (resp.costCents > 0) {
      const now = await ctx.date.now();
      ctx.genericSend<CostEntry>({
        service: "CostLedger",
        method: "record",
        key: req.identity.tenantId,
        parameter: {
          toolName: "guardrail:pii",
          costCents: resp.costCents,
          timestampMs: now,
          sessionId: req.identity.sessionId,
        },
        inputSerde: restate.serde.json,
      });
    }

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
