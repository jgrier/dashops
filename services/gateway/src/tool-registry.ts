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
  },
});

export type ToolRegistryService = typeof toolRegistry;
