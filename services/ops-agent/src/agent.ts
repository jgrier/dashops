import * as restate from "@restatedev/restate-sdk";
import type {
  ApprovalDecision,
  ApprovalRequestPayload,
  CallerIdentity,
  CallToolRequest,
  CallToolResponse,
  SessionMessage,
  SessionStatus,
} from "@dashops/shared";
import { planNext } from "./llm.js";

const MAX_STEPS = 16;
const MAX_APPROVAL_RETRIES = 1;

export async function runLoop(
  ctx: restate.ObjectContext,
  identity: CallerIdentity
): Promise<void> {
  for (let step = 0; step < MAX_STEPS; step++) {
    const messages = (await ctx.get<SessionMessage[]>("messages")) ?? [];

    await setStatus(ctx, "thinking");
    const plan = planNext(messages);
    await appendMessage(ctx, {
      id: ctx.rand.uuidv4(),
      role: "assistant",
      content: plan.thought,
      timestampMs: await ctx.date.now(),
    });

    if (plan.next.type === "final") {
      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "assistant",
        content: plan.next.reply,
        timestampMs: await ctx.date.now(),
      });
      await setStatus(ctx, "complete");
      return;
    }

    const ok = await dispatchToolCall(ctx, identity, plan.next.tool, plan.next.params);
    if (!ok) return;
  }

  await appendMessage(ctx, {
    id: ctx.rand.uuidv4(),
    role: "system",
    content: `Reagent loop exceeded ${MAX_STEPS} steps without reaching a conclusion.`,
    timestampMs: await ctx.date.now(),
  });
  await setStatus(ctx, "failed");
  await setFailureReason(ctx, "max_steps_exceeded");
}

async function dispatchToolCall(
  ctx: restate.ObjectContext,
  identity: CallerIdentity,
  tool: string,
  params: Record<string, unknown>
): Promise<boolean> {
  await setStatus(ctx, "calling_tool");

  let approvalToken: string | undefined;
  for (let attempt = 0; attempt <= MAX_APPROVAL_RETRIES; attempt++) {
    const req: CallToolRequest = { toolName: tool, params, identity, approvalToken };
    const resp = await ctx.genericCall<CallToolRequest, CallToolResponse>({
      service: "Gateway",
      method: "callTool",
      parameter: req,
      name: `gateway → ${tool}`,
      inputSerde: restate.serde.json,
      outputSerde: restate.serde.json,
    });

    if (resp.status === "ok") {
      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "tool",
        content: `→ ${tool}`,
        toolName: tool,
        toolResult: resp.result,
        costCents: resp.costCents,
        timestampMs: await ctx.date.now(),
      });
      return true;
    }

    if (resp.status === "blocked") {
      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "system",
        content: `Gateway blocked the call to ${tool}: ${resp.blocked?.message ?? "(no reason)"}`,
        timestampMs: await ctx.date.now(),
      });
      await setStatus(ctx, "failed");
      await setFailureReason(ctx, resp.blocked?.message ?? "blocked");
      return false;
    }

    if (resp.status === "needs_approval" && resp.approval) {
      const approvalId = ctx.rand.uuidv4();
      const awakeable = ctx.awakeable<ApprovalDecision>();

      ctx.set("pendingApproval", {
        approvalId,
        actionSummary: resp.approval.actionSummary,
        approverGroup: resp.approval.approverGroup,
        toolName: tool,
      });
      await setStatus(ctx, "needs_approval");

      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "system",
        content: `Waiting on approval from **${resp.approval.approverGroup}**: ${resp.approval.actionSummary}`,
        timestampMs: await ctx.date.now(),
      });

      const requestPayload: ApprovalRequestPayload = {
        awakeableId: awakeable.id,
        approverGroup: resp.approval.approverGroup,
        actionSummary: resp.approval.actionSummary,
        actionFingerprint: resp.approval.actionFingerprint,
        toolName: tool,
        toolParams: params,
        initiator: identity,
      };
      await ctx.genericCall<ApprovalRequestPayload, { approvalId: string }>({
        service: "ApprovalService",
        method: "requestApproval",
        key: approvalId,
        parameter: requestPayload,
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
        name: "approval · request",
      });

      let decision: ApprovalDecision;
      try {
        decision = await awakeable.promise;
      } catch (err) {
        await appendMessage(ctx, {
          id: ctx.rand.uuidv4(),
          role: "system",
          content: `Approval was cancelled: ${(err as Error).message}`,
          timestampMs: await ctx.date.now(),
        });
        ctx.clear("pendingApproval");
        await setStatus(ctx, "failed");
        await setFailureReason(ctx, "approval_cancelled");
        return false;
      }

      ctx.clear("pendingApproval");

      if (!decision.approved) {
        await appendMessage(ctx, {
          id: ctx.rand.uuidv4(),
          role: "system",
          content: `Approval rejected${decision.comment ? ": " + decision.comment : ""}.`,
          timestampMs: await ctx.date.now(),
        });
        await setStatus(ctx, "failed");
        await setFailureReason(ctx, "approval_rejected");
        return false;
      }

      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "system",
        content: `Approved${decision.approverUserId ? ` by ${decision.approverUserId}` : ""}. Proceeding with ${tool}.`,
        timestampMs: await ctx.date.now(),
      });

      approvalToken = approvalId;
      await setStatus(ctx, "calling_tool");
      continue;
    }

    await appendMessage(ctx, {
      id: ctx.rand.uuidv4(),
      role: "system",
      content: `Unrecognized gateway response status: ${resp.status}`,
      timestampMs: await ctx.date.now(),
    });
    await setStatus(ctx, "failed");
    return false;
  }

  await setStatus(ctx, "failed");
  await setFailureReason(ctx, "approval_retry_exhausted");
  return false;
}

// ----- state helpers ---------------------------------------------------------

export async function appendMessage(
  ctx: restate.ObjectContext,
  msg: SessionMessage
): Promise<void> {
  const messages = (await ctx.get<SessionMessage[]>("messages")) ?? [];
  messages.push(msg);
  ctx.set("messages", messages);
  ctx.set("updatedAtMs", await ctx.date.now());
}

export async function setStatus(
  ctx: restate.ObjectContext,
  status: SessionStatus
): Promise<void> {
  ctx.set("status", status);
  ctx.set("updatedAtMs", await ctx.date.now());
}

export async function setFailureReason(
  ctx: restate.ObjectContext,
  reason: string
): Promise<void> {
  ctx.set("failureReason", reason);
}
