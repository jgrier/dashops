import * as restate from "@restatedev/restate-sdk";
import type { ToolRegistration } from "@dashops/shared";

// VO keyed by registry-scope id (use "default" for the global registry).
// State: { tools: Record<toolName, ToolRegistration> }
export const toolRegistry = restate.object({
  name: "ToolRegistry",
  handlers: {
    register: async (
      ctx: restate.ObjectContext,
      registration: ToolRegistration
    ): Promise<string> => {
      const tools = (await ctx.get<Record<string, ToolRegistration>>("tools")) ?? {};
      tools[registration.name] = registration;
      ctx.set("tools", tools);
      return `registered ${registration.name}`;
    },

    unregister: async (
      ctx: restate.ObjectContext,
      name: string
    ): Promise<string> => {
      const tools = (await ctx.get<Record<string, ToolRegistration>>("tools")) ?? {};
      delete tools[name];
      ctx.set("tools", tools);
      return `unregistered ${name}`;
    },

    get: restate.handlers.object.shared(
      async (
        ctx: restate.ObjectSharedContext,
        name: string
      ): Promise<ToolRegistration | null> => {
        const tools = (await ctx.get<Record<string, ToolRegistration>>("tools")) ?? {};
        return tools[name] ?? null;
      }
    ),

    list: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<ToolRegistration[]> => {
        const tools = (await ctx.get<Record<string, ToolRegistration>>("tools")) ?? {};
        return Object.values(tools);
      }
    ),

    // Live-configurable rate limit. The rate-limit middleware reads
    // registration.rateLimit?.perMinute on every call, so the next acquire
    // uses the new value. The TokenBucket VO overwrites its stored
    // capacity + refillRate on each acquire too, so lowering the limit
    // immediately clamps tokens down and raising it lets the bucket refill
    // toward the new ceiling.
    updateRateLimit: async (
      ctx: restate.ObjectContext,
      req: { toolName: string; perMinute: number }
    ): Promise<{ ok: boolean; reason?: string }> => {
      const tools = (await ctx.get<Record<string, ToolRegistration>>("tools")) ?? {};
      const entry = tools[req.toolName];
      if (!entry) return { ok: false, reason: `unknown tool: ${req.toolName}` };
      const pm = Math.max(1, Math.min(600, Math.floor(req.perMinute)));
      entry.rateLimit = { perMinute: pm };
      tools[req.toolName] = entry;
      ctx.set("tools", tools);
      return { ok: true };
    },
  },
});

export type ToolRegistryService = typeof toolRegistry;
