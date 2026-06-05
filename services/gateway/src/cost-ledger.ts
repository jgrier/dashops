import * as restate from "@restatedev/restate-sdk";

export interface CostEntry {
  toolName: string;
  costCents: number;
  timestampMs: number;
  sessionId: string;
}

export interface CostSummary {
  tenantId: string;
  totalCents: number;
  entries: CostEntry[];
}

// VO keyed by tenant_id.
export const costLedger = restate.object({
  name: "CostLedger",
  handlers: {
    record: async (ctx: restate.ObjectContext, entry: CostEntry): Promise<number> => {
      const total = ((await ctx.get<number>("total")) ?? 0) + entry.costCents;
      const entries = ((await ctx.get<CostEntry[]>("entries")) ?? []).concat(entry);
      ctx.set("total", total);
      ctx.set("entries", entries.slice(-200));
      return total;
    },

    summary: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<CostSummary> => ({
        tenantId: ctx.key,
        totalCents: (await ctx.get<number>("total")) ?? 0,
        entries: (await ctx.get<CostEntry[]>("entries")) ?? [],
      })
    ),
  },
});

export type CostLedgerService = typeof costLedger;
