import * as restate from "@restatedev/restate-sdk";
import type {
  CallLLMRequest,
  CallLLMResponse,
  CallToolRequest,
  CallToolResponse,
  ToolPayload,
  ToolRegistration,
  ToolResult,
} from "@dashops/shared";
import type { CostEntry } from "./cost-ledger.js";
import { gatewayMiddlewares } from "./middlewares/index.js";
import type { MiddlewareContext, MiddlewareResult } from "./middlewares/types.js";
import { fingerprint } from "./policies.js";
import { recordCall, recentCalls, type CallLogEntry } from "./calls-log.js";

// The gateway: every agent ↔ tool call passes through here.
// Pipeline:
//   1. Registry lookup
//   2. Middleware chain (pii-guardrail → approval-policy → rate-limit, today)
//   3. Identity inject + downstream call
//   4. Cost record
export const gateway = restate.service({
  name: "Gateway",
  handlers: {
    callTool: async (
      ctx: restate.Context,
      req: CallToolRequest
    ): Promise<CallToolResponse> => {
      // Log every return path through a single helper. Wrapped in ctx.run so
      // replay (e.g. resume from a rate-limit ctx.sleep) doesn't dup-log.
      const invocationId = ctx.request().id as string;
      const log = async (
        response: CallToolResponse,
        extras?: { waitedMs?: number }
      ): Promise<CallToolResponse> => {
        const now = await ctx.date.now();
        await ctx.run("log call", () => {
          recordCall({
            timestampMs: now,
            kind: "tool",
            toolName: req.toolName,
            invocationId,
            traceId: req.identity.traceId,
            status: response.status,
            source:
              response.blocked?.source ??
              (response.status === "needs_approval" ? "approval-policy" : undefined),
            reason:
              response.blocked?.message ??
              response.approval?.actionSummary,
            tenantId: req.identity.tenantId,
            sessionId: req.identity.sessionId,
            costCents:
              response.status === "ok" ? response.costCents : undefined,
            waitedMs: extras?.waitedMs && extras.waitedMs > 0 ? extras.waitedMs : undefined,
            appealable: !!response.blocked?.appeal,
          });
        });
        return response;
      };

      // ---- Step 1: registry lookup
      const registration = await ctx.genericCall<string, ToolRegistration | null>({
        service: "ToolRegistry",
        method: "get",
        key: "default",
        parameter: req.toolName,
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
      });

      if (!registration) {
        return log({
          status: "blocked",
          toolName: req.toolName,
          blocked: { source: "registry", message: `unknown tool: ${req.toolName}` },
        });
      }

      // ---- Step 1b: if this is an appeal-retry, verify the appeal token.
      // The token must (a) reference an approved appeal record AND (b) the
      // appeal must have been issued for THIS exact call (matched by
      // fingerprint). If both hold, we trust the bypassMiddlewares list.
      if (req.appealToken) {
        type VerifyResp = { ok: boolean; reason?: string };
        const callFingerprint = fingerprint(req.toolName, req.params);
        const verify = await ctx.genericCall<{ actionFingerprint: string }, VerifyResp>({
          service: "ApprovalService",
          method: "verifyToken",
          key: req.appealToken,
          parameter: { actionFingerprint: callFingerprint },
          inputSerde: restate.serde.json,
          outputSerde: restate.serde.json,
          name: "appeal · verify",
        });
        if (!verify.ok) {
          return log({
            status: "blocked",
            toolName: req.toolName,
            blocked: {
              source: "appeal",
              message: verify.reason ?? "appeal token invalid",
            },
          });
        }
      }

      const mctx: MiddlewareContext = { request: req, registration };

      // ---- Step 2: run the middleware chain
      const chainOutcome = await runMiddlewareChain(ctx, mctx);
      if (chainOutcome.result) {
        return log(chainOutcome.result, { waitedMs: chainOutcome.waitedMs });
      }

      // ---- Step 3: identity inject + downstream dispatch
      const payload: ToolPayload = { params: req.params, identity: req.identity };
      const toolResult = await ctx.genericCall<ToolPayload, ToolResult>({
        service: registration.serviceName,
        method: registration.handlerName ?? "execute",
        parameter: payload,
        name: `→ ${req.toolName}`,
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
      });

      // ---- Step 4: record cost
      const costCents = toolResult.costCents ?? registration.configuredCostCents ?? 0;
      if (costCents > 0) {
        const now = await ctx.date.now();
        ctx.genericSend<CostEntry>({
          service: "CostLedger",
          method: "record",
          key: req.identity.tenantId,
          parameter: {
            toolName: req.toolName,
            costCents,
            timestampMs: now,
            sessionId: req.identity.sessionId,
          },
          inputSerde: restate.serde.json,
        });
      }

      return log(
        {
          status: "ok",
          toolName: req.toolName,
          result: toolResult.result,
          costCents,
        },
        { waitedMs: chainOutcome.waitedMs }
      );
    },

    // ---- callLLM ---------------------------------------------------------
    // Parallel surface to callTool, but for LLM calls. The same gateway-level
    // concerns apply (cost, audit, future rate-limit/PII scrubbing); we just
    // route to LLMService instead of through the tool registry. Today the
    // middleware chain is intentionally bypassed because (a) PII scrubbing on
    // prompts needs a different scanner shape than tool params, and (b) the
    // PII guardrail itself routes through here, so running the chain would
    // recurse. Both are tractable later.
    callLLM: async (
      ctx: restate.Context,
      req: CallLLMRequest
    ): Promise<CallLLMResponse> => {
      const now = await ctx.date.now();
      const invocationId = ctx.request().id as string;

      const result = await ctx.genericCall<CallLLMRequest, CallLLMResponse>({
        service: "LLMService",
        method: "complete",
        parameter: req,
        name: `→ llm:${req.purpose}`,
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
      });

      if (result.costCents > 0) {
        ctx.genericSend<CostEntry>({
          service: "CostLedger",
          method: "record",
          key: req.identity.tenantId,
          parameter: {
            toolName: `llm:${req.purpose}`,
            costCents: result.costCents,
            timestampMs: now,
            sessionId: req.identity.sessionId,
          },
          inputSerde: restate.serde.json,
        });
      }

      await ctx.run("log llm call", () => {
        recordCall({
          timestampMs: now,
          kind: "llm",
          toolName: `llm:${req.purpose}`,
          invocationId,
          traceId: req.identity.traceId,
          status: result.status,
          reason: result.mode === "live" ? "live mode" : "stub mode",
          tenantId: req.identity.tenantId,
          sessionId: req.identity.sessionId,
          costCents: result.costCents,
        });
      });

      return result;
    },

    // ---- Observability ---------------------------------------------------
    // Narrow data-only read. The BFF queries this when rendering the
    // gateway ops page; no HTML lives in this service.
    recentCalls: async (_ctx: restate.Context): Promise<CallLogEntry[]> => {
      return recentCalls();
    },
  },
});

// Walks the middleware chain. Returns the short-circuit response if any
// middleware blocks; otherwise null result, and the total time the call
// spent sleeping in rate-limit waits (for the gateway calls log).
async function runMiddlewareChain(
  ctx: restate.Context,
  mctx: MiddlewareContext
): Promise<{ result: CallToolResponse | null; waitedMs: number }> {
  let waitedMs = 0;
  for (const mw of gatewayMiddlewares) {
    // Skip middlewares the caller has been explicitly authorized to bypass
    // (e.g. an appeal was granted). Each bypass is bound to a specific
    // call fingerprint by the appeal token verification — see commit 2.
    if (mctx.request.bypassMiddlewares?.includes(mw.name)) continue;

    // Some middlewares (rate-limit) can return `wait`; re-check after sleep.
    // Cap loops to avoid pathological waits.
    for (let i = 0; i < 8; i++) {
      const result: MiddlewareResult = await mw.check(ctx, mctx);
      if (result.kind === "pass") break;
      if (result.kind === "wait") {
        waitedMs += result.ms;
        await ctx.sleep(result.ms);
        continue;
      }
      // block / block_appealable / needs_human — short-circuit
      return {
        result: wrapResultAsResponse(mctx.request.toolName, result, mctx.request),
        waitedMs,
      };
    }
  }
  return { result: null, waitedMs };
}

function wrapResultAsResponse(
  toolName: string,
  result: MiddlewareResult,
  req: CallToolRequest
): CallToolResponse {
  switch (result.kind) {
    case "block":
      return {
        status: "blocked",
        toolName,
        blocked: { source: result.source, message: result.reason, details: result.details },
      };
    case "block_appealable":
      return {
        status: "blocked",
        toolName,
        blocked: {
          source: result.source,
          message: result.reason,
          details: result.details,
          appeal: {
            approverGroup: result.appeal.approverGroup,
            summaryHint: result.appeal.summaryHint,
            middlewareName: result.source,
            actionFingerprint: fingerprint(req.toolName, req.params),
          },
        },
      };
    case "needs_human":
      return {
        status: "needs_approval",
        toolName,
        approval: {
          approverGroup: result.approverGroup,
          actionSummary: result.actionSummary,
          actionFingerprint: result.actionFingerprint,
        },
      };
    default:
      // Unreachable for the four short-circuit kinds.
      return {
        status: "blocked",
        toolName,
        blocked: { source: "gateway", message: "unhandled middleware result" },
      };
  }
}
