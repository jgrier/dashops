import * as restate from "@restatedev/restate-sdk";
import type {
  CallToolRequest,
  CallToolResponse,
  ToolPayload,
  ToolRegistration,
  ToolResult,
} from "@dashops/shared";
import type { CostEntry } from "./cost-ledger.js";
import { policies, fingerprint } from "./policies.js";

// The gateway: every agent ↔ tool call passes through here.
// Pipeline:
//   1. Registry lookup
//   2. PII guardrail (Phase 2)
//   3. Approval policy check — unless an approval_token says we already passed (Phase 3)
//   4. Identity inject + downstream call
//   5. Cost record
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

      // ---- Step 2: PII guardrail (skip for action retries with approval_token —
      // the params were already vetted on the first pass).
      if (!req.approvalToken) {
        type PIIResp = { flagged: boolean; reason?: string; detected?: unknown; costCents: number };
        const piiResp = await ctx.genericCall<{ params: Record<string, unknown>; toolName: string }, PIIResp>({
          service: "PIIGuardrail",
          method: "check",
          parameter: { params: req.params, toolName: req.toolName },
          inputSerde: restate.serde.json,
          outputSerde: restate.serde.json,
          name: "guardrail · PII",
        });

        if (piiResp.costCents > 0) {
          const now = await ctx.date.now();
          ctx.genericSend<CostEntry>({
            service: "CostLedger",
            method: "record",
            key: req.identity.tenantId,
            parameter: {
              toolName: "guardrail:pii",
              costCents: piiResp.costCents,
              timestampMs: now,
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
      }

      // ---- Step 3: approval policy
      const policy = policies[req.toolName];
      const callFingerprint = fingerprint(req.toolName, req.params);

      if (policy && policy.condition(req.params)) {
        if (req.approvalToken) {
          // Verify token against ApprovalService
          type VerifyResp = { ok: boolean; reason?: string };
          const verify = await ctx.genericCall<{ actionFingerprint: string }, VerifyResp>({
            service: "ApprovalService",
            method: "verifyToken",
            key: req.approvalToken,
            parameter: { actionFingerprint: callFingerprint },
            inputSerde: restate.serde.json,
            outputSerde: restate.serde.json,
            name: "approval · verify",
          });
          if (!verify.ok) {
            return {
              status: "blocked",
              toolName: req.toolName,
              blocked: {
                source: "approval",
                message: verify.reason ?? "approval token invalid",
              },
            };
          }
          // approved — fall through to dispatch
        } else {
          return {
            status: "needs_approval",
            toolName: req.toolName,
            approval: {
              approverGroup: policy.approverGroup,
              actionSummary: policy.summary(req.params),
              actionFingerprint: callFingerprint,
            },
          };
        }
      }

      // ---- Step 4: identity inject + downstream dispatch
      const payload: ToolPayload = { params: req.params, identity: req.identity };
      const toolResult = await ctx.genericCall<ToolPayload, ToolResult>({
        service: registration.serviceName,
        method: registration.handlerName ?? "execute",
        parameter: payload,
        name: `→ ${req.toolName}`,
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
      });

      // ---- Step 5: record cost
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
