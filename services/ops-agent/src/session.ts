import * as restate from "@restatedev/restate-sdk";
import type {
  CallerIdentity,
  SessionMessage,
  SessionState,
  SessionStatus,
} from "@dashops/shared";
import { appendMessage, runLoop, setStatus } from "./agent.js";

// Virtual Object keyed by session_id. Owns the conversation, runs the reagent
// loop, and exposes a read-only view for the operator UI.
export const session = restate.object({
  name: "Session",
  handlers: {
    sendMessage: async (ctx: restate.ObjectContext, message: string): Promise<void> => {
      const sessionId = ctx.key;
      const initialized = (await ctx.get<number>("createdAtMs")) !== null;
      if (!initialized) {
        ctx.set("createdAtMs", Date.now());
        ctx.set("messages", [] as SessionMessage[]);
      }

      await appendMessage(ctx, {
        id: ctx.rand.uuidv4(),
        role: "user",
        content: message,
        timestampMs: Date.now(),
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

    getState: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<SessionState> => {
        return {
          sessionId: ctx.key,
          status: ((await ctx.get<SessionStatus>("status")) ?? "idle"),
          messages: (await ctx.get<SessionMessage[]>("messages")) ?? [],
          failureReason: (await ctx.get<string>("failureReason")) ?? undefined,
          createdAtMs: (await ctx.get<number>("createdAtMs")) ?? Date.now(),
          updatedAtMs: (await ctx.get<number>("updatedAtMs")) ?? Date.now(),
        };
      }
    ),
  },
});
