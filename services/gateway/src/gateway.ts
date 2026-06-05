import * as restate from "@restatedev/restate-sdk";
import type {
  CallToolRequest,
  CallToolResponse,
  ToolPayload,
  ToolRegistration,
  ToolResult,
} from "@dashops/shared";
import type { CostEntry } from "./cost-ledger.js";

// The gateway: every agent ↔ tool call passes through here.
// Phase 1 pipeline (minimal):
//   1. Look up tool in registry
//   2. (auth, guardrails, approval, rate-limit deferred to later phases)
//   3. Inject identity into downstream payload
//   4. Call downstream tool by name (dynamic dispatch via genericCall)
//   5. Record cost
export const gateway = restate.service({
  name: "Gateway",
  handlers: {
    callTool: async (
      ctx: restate.Context,
      req: CallToolRequest
    ): Promise<CallToolResponse> => {
      // Step 1: registry lookup
      const registration = await ctx
        .genericCall<string, ToolRegistration | null>({
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
          blocked: {
            source: "registry",
            message: `unknown tool: ${req.toolName}`,
          },
        };
      }

      // Step 3 (Phase 2): PII guardrail — inspect outbound params before dispatch.
      type PIIResp = { flagged: boolean; reason?: string; detected?: unknown; costCents: number };
      const piiResp = await ctx.genericCall<{ params: Record<string, unknown>; toolName: string }, PIIResp>({
        service: "PIIGuardrail",
        method: "check",
        parameter: { params: req.params, toolName: req.toolName },
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
        name: "guardrail · PII",
      });

      // Record guardrail cost in the tenant ledger (even when not flagged).
      if (piiResp.costCents > 0) {
        ctx.genericSend<CostEntry>({
          service: "CostLedger",
          method: "record",
          key: req.identity.tenantId,
          parameter: {
            toolName: "guardrail:pii",
            costCents: piiResp.costCents,
            timestampMs: Date.now(),
            sessionId: req.identity.sessionId,
          },
          inputSerde: restate.serde.json,
        });
      }

      if (piiResp.flagged) {
        return {
          status: "blocked",
          toolName: req.toolName,
          blocked: {
            source: "pii-guardrail",
            message: piiResp.reason ?? "PII detected",
            details: piiResp.detected,
          },
        };
      }

      // Step 6: identity is on the request; build the downstream payload
      const payload: ToolPayload = { params: req.params, identity: req.identity };

      // Step 4: dispatch to the downstream tool
      const toolResult = await ctx.genericCall<ToolPayload, ToolResult>({
        service: registration.serviceName,
        method: registration.handlerName ?? "execute",
        parameter: payload,
        name: `→ ${req.toolName}`,
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
      });

      // Step 5: record cost (tool self-reports if it can; else fall back to config)
      const costCents = toolResult.costCents ?? registration.configuredCostCents ?? 0;
      if (costCents > 0) {
        const entry: CostEntry = {
          toolName: req.toolName,
          costCents,
          timestampMs: Date.now(),
          sessionId: req.identity.sessionId,
        };
        ctx.genericSend<CostEntry>({
          service: "CostLedger",
          method: "record",
          key: req.identity.tenantId,
          parameter: entry,
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

export type GatewayService = typeof gateway;
