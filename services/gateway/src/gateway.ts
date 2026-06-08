import * as restate from "@restatedev/restate-sdk";
import type {
  CallToolRequest,
  CallToolResponse,
  ToolPayload,
  ToolRegistration,
  ToolResult,
} from "@dashops/shared";
import type { CostEntry } from "./cost-ledger.js";
import { gatewayMiddlewares } from "./middlewares/index.js";
import type { MiddlewareContext, MiddlewareResult } from "./middlewares/types.js";

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
        return {
          status: "blocked",
          toolName: req.toolName,
          blocked: { source: "registry", message: `unknown tool: ${req.toolName}` },
        };
      }

      const mctx: MiddlewareContext = { request: req, registration };

      // ---- Step 2: run the middleware chain
      const chainResult = await runMiddlewareChain(ctx, mctx);
      if (chainResult) return chainResult;

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

      return {
        status: "ok",
        toolName: req.toolName,
        result: toolResult.result,
        costCents,
      };
    },
  },
});

// Walks the middleware chain. Returns null if all middlewares pass (caller
// should proceed to dispatch). Returns a CallToolResponse if any middleware
// short-circuits the call.
async function runMiddlewareChain(
  ctx: restate.Context,
  mctx: MiddlewareContext
): Promise<CallToolResponse | null> {
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
        await ctx.sleep(result.ms);
        continue;
      }
      // block / block_appealable / needs_human — short-circuit
      return wrapResultAsResponse(mctx.request.toolName, result);
    }
  }
  return null;
}

function wrapResultAsResponse(
  toolName: string,
  result: MiddlewareResult
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
          // Action fingerprint isn't computed here because individual middlewares
          // may not know how to compute it; we set it at the call site if needed.
          // For commit 2, ops-agent will compute the fingerprint when issuing
          // the appeal request.
          appeal: {
            approverGroup: result.appeal.approverGroup,
            summaryHint: result.appeal.summaryHint,
            middlewareName: result.source,
            actionFingerprint: "",   // ops-agent fills this in when creating the appeal
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
