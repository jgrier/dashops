import * as restate from "@restatedev/restate-sdk";
import type {
  CallerIdentity,
  CallToolRequest,
  CallToolResponse,
  SessionMessage,
  SessionStatus,
} from "@dashops/shared";
import { planNext } from "./llm.js";

const MAX_STEPS = 12;   // safety cap on the reagent loop

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
      timestampMs: Date.now(),
    });

    if (plan.next.type === "final") {
      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "assistant",
        content: plan.next.reply,
        timestampMs: Date.now(),
      });
      await setStatus(ctx, "complete");
      return;
    }

    // tool_call
    await setStatus(ctx, "calling_tool");
    const req: CallToolRequest = {
      toolName: plan.next.tool,
      params: plan.next.params,
      identity,
    };
    const toolResp = await ctx.genericCall<CallToolRequest, CallToolResponse>({
      service: "Gateway",
      method: "callTool",
      parameter: req,
      name: `gateway → ${plan.next.tool}`,
      inputSerde: restate.serde.json,
      outputSerde: restate.serde.json,
    });

    if (toolResp.status === "blocked") {
      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "system",
        content: `Gateway blocked the call to ${plan.next.tool}: ${
          toolResp.blocked?.message ?? "(no reason)"
        }`,
        timestampMs: Date.now(),
      });
      await setStatus(ctx, "failed");
      await setFailureReason(ctx, toolResp.blocked?.message ?? "blocked");
      return;
    }

    await appendMessage(ctx, {
      id: ctx.rand.uuidv4(),
      role: "tool",
      content: `→ ${plan.next.tool}`,
      toolName: plan.next.tool,
      toolResult: toolResp.result,
      costCents: toolResp.costCents,
      timestampMs: Date.now(),
    });
  }

  // Exceeded MAX_STEPS — fail the session cleanly.
  await appendMessage(ctx, {
    id: ctx.rand.uuidv4(),
    role: "system",
    content: `Reagent loop exceeded ${MAX_STEPS} steps without reaching a conclusion.`,
    timestampMs: Date.now(),
  });
  await setStatus(ctx, "failed");
  await setFailureReason(ctx, "max_steps_exceeded");
}

// ----- state helpers ---------------------------------------------------------

export async function appendMessage(
  ctx: restate.ObjectContext,
  msg: SessionMessage
): Promise<void> {
  const messages = (await ctx.get<SessionMessage[]>("messages")) ?? [];
  messages.push(msg);
  ctx.set("messages", messages);
  ctx.set("updatedAtMs", Date.now());
}

export async function setStatus(
  ctx: restate.ObjectContext,
  status: SessionStatus
): Promise<void> {
  ctx.set("status", status);
  ctx.set("updatedAtMs", Date.now());
}

export async function setFailureReason(
  ctx: restate.ObjectContext,
  reason: string
): Promise<void> {
  ctx.set("failureReason", reason);
}
