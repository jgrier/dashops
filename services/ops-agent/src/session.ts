import * as restate from "@restatedev/restate-sdk";
import type {
  ApprovalDecision,
  ApprovalRequestPayload,
  CallerIdentity,
  CallToolRequest,
  CallToolResponse,
  SessionMessage,
  SessionState,
  SessionStatus,
} from "@dashops/shared";
import { appendMessage, runLoop, setFailureReason, setStatus } from "./agent.js";

// Virtual Object keyed by session_id. Owns the conversation, runs the reagent
// loop, and exposes a read-only view for the operator UI.
export const session = restate.object({
  name: "Session",
  handlers: {
    sendMessage: async (ctx: restate.ObjectContext, message: string): Promise<void> => {
      const sessionId = ctx.key;
      const initialized = (await ctx.get<number>("createdAtMs")) !== null;
      if (!initialized) {
        ctx.set("createdAtMs", await ctx.date.now());
        ctx.set("messages", [] as SessionMessage[]);
      }

      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "user",
        content: message,
        timestampMs: await ctx.date.now(),
      });

      const identity: CallerIdentity = {
        tenantId: "demo-tenant",
        userId: "demo-operator",
        agentId: "ops-agent-v1",
        sessionId,
        traceId: ctx.rand.uuidv4(),
      };

      await runLoop(ctx, identity);
    },

    reset: async (ctx: restate.ObjectContext): Promise<void> => {
      ctx.clearAll();
    },

    // Operator-initiated appeal of an appealable block. Reads the pending
    // appeal info from state, creates an awakeable, asks ApprovalService
    // for a human decision, suspends. On approve, retries the original
    // gateway call with the appeal token + bypass list.
    requestAppeal: async (ctx: restate.ObjectContext): Promise<void> => {
      const pending = await ctx.get<SessionState["pendingAppeal"]>("pendingAppeal");
      if (!pending) return;
      const status = (await ctx.get<SessionStatus>("status")) ?? "idle";
      if (status !== "blocked_appealable") return;

      const sessionId = ctx.key;
      const identity: CallerIdentity = {
        tenantId: "demo-tenant",
        userId: "demo-operator",
        agentId: "ops-agent-v1",
        sessionId,
        traceId: ctx.rand.uuidv4(),
      };

      const approvalId = ctx.rand.uuidv4();
      const awakeable = ctx.awakeable<ApprovalDecision>();

      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "system",
        content: `Requesting human review of the ${pending.blockSource} block from **${pending.approverGroup}**.`,
        timestampMs: await ctx.date.now(),
      });
      await setStatus(ctx, "appeal_pending");

      const payload: ApprovalRequestPayload = {
        awakeableId: awakeable.id,
        approverGroup: pending.approverGroup,
        actionSummary: `${pending.summaryHint} (call: ${pending.toolName})`,
        actionFingerprint: pending.actionFingerprint,
        toolName: pending.toolName,
        toolParams: pending.params,
        initiator: identity,
        kind: "appeal",
        appealBypassMiddleware: pending.blockSource,
      };
      await ctx.genericCall<ApprovalRequestPayload, { approvalId: string }>({
        service: "ApprovalService",
        method: "requestApproval",
        key: approvalId,
        parameter: payload,
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
        name: "appeal · request",
      });

      let decision: ApprovalDecision;
      try {
        decision = await awakeable.promise;
      } catch (err) {
        await appendMessage(ctx, {
          id: ctx.rand.uuidv4(),
          role: "system",
          content: `Appeal cancelled: ${(err as Error).message}`,
          timestampMs: await ctx.date.now(),
        });
        await setStatus(ctx, "failed");
        await setFailureReason(ctx, "appeal_cancelled");
        return;
      }

      if (!decision.approved) {
        await appendMessage(ctx, {
          id: ctx.rand.uuidv4(),
          role: "system",
          content: `Appeal rejected${decision.comment ? ": " + decision.comment : ""}.`,
          timestampMs: await ctx.date.now(),
        });
        ctx.clear("pendingAppeal");
        await setStatus(ctx, "failed");
        await setFailureReason(ctx, "appeal_rejected");
        return;
      }

      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "system",
        content: `Appeal approved${decision.approverUserId ? ` by ${decision.approverUserId}` : ""}. Retrying ${pending.toolName}.`,
        timestampMs: await ctx.date.now(),
      });

      // Retry the gateway call, this time bypassing the middleware that blocked.
      const req: CallToolRequest = {
        toolName: pending.toolName,
        params: pending.params,
        identity,
        appealToken: approvalId,
        bypassMiddlewares: [pending.blockSource],
      };
      const resp = await ctx.genericCall<CallToolRequest, CallToolResponse>({
        service: "Gateway",
        method: "callTool",
        parameter: req,
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
        name: `gateway · appeal-retry → ${pending.toolName}`,
      });

      ctx.clear("pendingAppeal");

      if (resp.status === "ok") {
        await appendMessage(ctx, {
          id: ctx.rand.uuidv4(),
          role: "tool",
          content: `→ ${pending.toolName}`,
          toolName: pending.toolName,
          toolResult: resp.result,
          costCents: resp.costCents,
          timestampMs: await ctx.date.now(),
        });
        await setStatus(ctx, "complete");
        return;
      }

      // Retry failed somehow (rate limit, missing tool, etc.). Surface it.
      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "system",
        content: `Appeal-retry failed: ${resp.blocked?.message ?? resp.status}`,
        timestampMs: await ctx.date.now(),
      });
      await setStatus(ctx, "failed");
      await setFailureReason(ctx, "appeal_retry_failed");
    },

    getState: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<SessionState> => {
        return {
          sessionId: ctx.key,
          status: ((await ctx.get<SessionStatus>("status")) ?? "idle"),
          messages: (await ctx.get<SessionMessage[]>("messages")) ?? [],
          pendingApproval: (await ctx.get("pendingApproval")) as SessionState["pendingApproval"],
          pendingAppeal: (await ctx.get("pendingAppeal")) as SessionState["pendingAppeal"],
          failureReason: (await ctx.get<string>("failureReason")) ?? undefined,
          createdAtMs: (await ctx.get<number>("createdAtMs")) ?? 0,
          updatedAtMs: (await ctx.get<number>("updatedAtMs")) ?? 0,
        };
      }
    ),
  },
});
