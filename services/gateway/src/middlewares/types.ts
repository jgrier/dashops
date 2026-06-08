import * as restate from "@restatedev/restate-sdk";
import type { CallToolRequest, ToolRegistration } from "@dashops/shared";

// Per-call internal context handed to every middleware.
export interface MiddlewareContext {
  request: CallToolRequest;
  registration: ToolRegistration;
}

// What a middleware can decide. The gateway pipeline routes on `kind`.
export type MiddlewareResult =
  // Continue to the next middleware (or to dispatch).
  | { kind: "pass" }
  // Hard stop. The call will not be retried by appeal.
  | { kind: "block"; source: string; reason: string; details?: unknown }
  // Soft stop. The operator can escalate to a human reviewer; if granted,
  // the call retries with bypassMiddlewares set to skip this one.
  | {
      kind: "block_appealable";
      source: string;
      reason: string;
      details?: unknown;
      appeal: { approverGroup: string; summaryHint: string };
    }
  // The call needs a named human group to approve before proceeding.
  // Used by the approval-policy middleware.
  | {
      kind: "needs_human";
      approverGroup: string;
      actionSummary: string;
      actionFingerprint: string;
    }
  // The middleware wants to delay this call. The gateway will `ctx.sleep`
  // for `ms`, then re-check the same middleware. Used by rate-limit.
  | { kind: "wait"; ms: number };

export interface Middleware {
  name: string;
  check(
    ctx: restate.Context,
    mctx: MiddlewareContext
  ): Promise<MiddlewareResult>;
}
