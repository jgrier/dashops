import * as restate from "@restatedev/restate-sdk";
import type {
  ApprovalRequestPayload,
  ApprovalDecision,
  ApprovalRecord,
  DecidedApprovalSummary,
} from "@dashops/shared";

// Fire-and-forget the decision summary into the per-group history index.
// Single place so respond + cancel agree on the payload shape.
function indexDecision(
  ctx: restate.ObjectContext,
  group: string,
  summary: DecidedApprovalSummary
): void {
  ctx.genericSend({
    service: "DecidedApprovalsIndex",
    method: "add",
    key: group,
    parameter: summary,
    inputSerde: restate.serde.json,
  });
}

// ApprovalService — VO keyed by approval_id. One instance per pending
// approval. Holds the awakeable id, the action context, the decision, and
// the audit trail.
export const approvalService = restate.object({
  name: "ApprovalService",
  handlers: {
    requestApproval: async (
      ctx: restate.ObjectContext,
      payload: ApprovalRequestPayload
    ): Promise<{ approvalId: string }> => {
      const now = await ctx.date.now();
      const kind = payload.kind ?? "approval";
      ctx.set("status", "pending");
      ctx.set("kind", kind);
      ctx.set("awakeableId", payload.awakeableId);
      ctx.set("approverGroup", payload.approverGroup);
      ctx.set("actionSummary", payload.actionSummary);
      ctx.set("actionFingerprint", payload.actionFingerprint);
      ctx.set("toolName", payload.toolName);
      ctx.set("toolParams", payload.toolParams);
      ctx.set("initiator", payload.initiator);
      if (payload.appealBypassMiddleware) {
        ctx.set("appealBypassMiddleware", payload.appealBypassMiddleware);
      }
      ctx.set("createdAtMs", now);

      ctx.genericSend({
        service: "PendingApprovalsIndex",
        method: "add",
        key: payload.approverGroup,
        parameter: {
          approvalId: ctx.key,
          actionSummary: payload.actionSummary,
          initiator: { userId: payload.initiator.userId, sessionId: payload.initiator.sessionId },
          toolName: payload.toolName,
          createdAtMs: now,
          kind,
        },
        inputSerde: restate.serde.json,
      });

      return { approvalId: ctx.key };
    },

    respond: async (
      ctx: restate.ObjectContext,
      decision: ApprovalDecision
    ): Promise<{ ok: true }> => {
      const status = await ctx.get<string>("status");
      if (status !== "pending") {
        throw new restate.TerminalError(`approval is not pending (status=${status})`);
      }
      const awakeableId = await ctx.get<string>("awakeableId");
      if (!awakeableId) {
        throw new restate.TerminalError(`no awakeable id stored`);
      }

      const decidedAtMs = await ctx.date.now();
      ctx.set("status", decision.approved ? "approved" : "rejected");
      ctx.set("decision", decision);
      ctx.set("decidedAtMs", decidedAtMs);

      // Wake the ops-agent.
      ctx.resolveAwakeable(awakeableId, decision);

      const group = await ctx.get<string>("approverGroup");
      if (group) {
        ctx.genericSend({
          service: "PendingApprovalsIndex",
          method: "remove",
          key: group,
          parameter: { approvalId: ctx.key },
          inputSerde: restate.serde.json,
        });

        // Audit log: snapshot the decision into the per-group history.
        const initiator = (await ctx.get("initiator")) as ApprovalRecord["initiator"];
        indexDecision(ctx, group, {
          approvalId: ctx.key,
          actionSummary: (await ctx.get<string>("actionSummary")) ?? "",
          initiator: { userId: initiator?.userId ?? "?", sessionId: initiator?.sessionId ?? "?" },
          createdAtMs: (await ctx.get<number>("createdAtMs")) ?? decidedAtMs,
          decidedAtMs,
          toolName: (await ctx.get<string>("toolName")) ?? "",
          kind: ((await ctx.get<string>("kind")) ?? "approval") as "approval" | "appeal",
          outcome: decision.approved ? "approved" : "rejected",
          approverUserId: decision.approverUserId,
          comment: decision.comment,
        });
      }
      return { ok: true };
    },

    cancel: async (ctx: restate.ObjectContext, reason: string): Promise<{ ok: true }> => {
      const status = await ctx.get<string>("status");
      if (status !== "pending") return { ok: true };
      const decidedAtMs = await ctx.date.now();
      ctx.set("status", "cancelled");
      ctx.set("decidedAtMs", decidedAtMs);

      const awakeableId = await ctx.get<string>("awakeableId");
      if (awakeableId) {
        ctx.rejectAwakeable(awakeableId, `cancelled: ${reason}`);
      }
      const group = await ctx.get<string>("approverGroup");
      if (group) {
        ctx.genericSend({
          service: "PendingApprovalsIndex",
          method: "remove",
          key: group,
          parameter: { approvalId: ctx.key },
          inputSerde: restate.serde.json,
        });

        const initiator = (await ctx.get("initiator")) as ApprovalRecord["initiator"];
        indexDecision(ctx, group, {
          approvalId: ctx.key,
          actionSummary: (await ctx.get<string>("actionSummary")) ?? "",
          initiator: { userId: initiator?.userId ?? "?", sessionId: initiator?.sessionId ?? "?" },
          createdAtMs: (await ctx.get<number>("createdAtMs")) ?? decidedAtMs,
          decidedAtMs,
          toolName: (await ctx.get<string>("toolName")) ?? "",
          kind: ((await ctx.get<string>("kind")) ?? "approval") as "approval" | "appeal",
          outcome: "cancelled",
          comment: `cancelled: ${reason}`,
        });
      }
      return { ok: true };
    },

    verifyToken: restate.handlers.object.shared(
      async (
        ctx: restate.ObjectSharedContext,
        params: { actionFingerprint: string }
      ): Promise<{ ok: boolean; reason?: string }> => {
        const status = await ctx.get<string>("status");
        const fingerprint = await ctx.get<string>("actionFingerprint");
        if (status !== "approved") return { ok: false, reason: `approval status=${status}` };
        if (fingerprint !== params.actionFingerprint) {
          return { ok: false, reason: "action fingerprint mismatch (approval issued for a different action)" };
        }
        return { ok: true };
      }
    ),

    getRecord: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<ApprovalRecord | null> => {
        const createdAtMs = await ctx.get<number>("createdAtMs");
        if (createdAtMs === null) return null;
        return {
          approvalId: ctx.key,
          status: ((await ctx.get<string>("status")) ?? "pending") as ApprovalRecord["status"],
          approverGroup: (await ctx.get<string>("approverGroup")) ?? "",
          actionSummary: (await ctx.get<string>("actionSummary")) ?? "",
          actionFingerprint: (await ctx.get<string>("actionFingerprint")) ?? "",
          toolName: (await ctx.get<string>("toolName")) ?? "",
          toolParams: (await ctx.get<Record<string, unknown>>("toolParams")) ?? {},
          initiator: (await ctx.get("initiator")) as ApprovalRecord["initiator"],
          decision: (await ctx.get<ApprovalDecision>("decision")) ?? undefined,
          createdAtMs,
          decidedAtMs: (await ctx.get<number>("decidedAtMs")) ?? undefined,
        };
      }
    ),

    // Shared introspection of the appeal-specific bits (so ops-agent can
    // look up which middleware to bypass and recover params after suspending).
    getKind: restate.handlers.object.shared(
      async (
        ctx: restate.ObjectSharedContext
      ): Promise<{ kind: string; appealBypassMiddleware?: string }> => ({
        kind: (await ctx.get<string>("kind")) ?? "approval",
        appealBypassMiddleware:
          (await ctx.get<string>("appealBypassMiddleware")) ?? undefined,
      })
    ),
  },
});
