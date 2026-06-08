import * as restate from "@restatedev/restate-sdk";
import type { Middleware, MiddlewareResult, MiddlewareContext } from "./types.js";
import { policies, fingerprint } from "../policies.js";

// Checks the static policy table for this tool. If the call's params match a
// gated condition AND no approval_token is present, returns needs_human.
// On retry with a valid approval_token, verifies via ApprovalService and
// passes through.
export const approvalPolicyMW: Middleware = {
  name: "approval-policy",
  async check(
    ctx: restate.Context,
    mctx: MiddlewareContext
  ): Promise<MiddlewareResult> {
    const req = mctx.request;
    const policy = policies[req.toolName];
    if (!policy) return { kind: "pass" };
    if (!policy.condition(req.params)) return { kind: "pass" };

    const callFingerprint = fingerprint(req.toolName, req.params);

    if (req.approvalToken) {
      type VerifyResp = { ok: boolean; reason?: string };
      const verify = await ctx.genericCall<{ actionFingerprint: string }, VerifyResp>({
        service: "ApprovalService",
        method: "verifyToken",
        key: req.approvalToken,
        parameter: { actionFingerprint: callFingerprint },
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
        name: "mw · approval · verify",
      });
      if (!verify.ok) {
        return {
          kind: "block",
          source: "approval-policy",
          reason: verify.reason ?? "approval token invalid",
        };
      }
      return { kind: "pass" };
    }

    return {
      kind: "needs_human",
      approverGroup: policy.approverGroup,
      actionSummary: policy.summary(req.params),
      actionFingerprint: callFingerprint,
    };
  },
};
