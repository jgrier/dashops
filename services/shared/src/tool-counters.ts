// In-process counters for tool invocations. Each tool service maintains its
// own counts (no cross-service state). Reset on restart.
//
// Wire it from a handler:
//   import { bumpToolCount } from "@dashops/shared";
//   bumpToolCount("delivery_lookup");

const counts = new Map<string, number>();
const lastInvokedAt = new Map<string, number>();

export function bumpToolCount(name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
  lastInvokedAt.set(name, Date.now());
}

export interface ToolCounterSnapshot {
  name: string;
  count: number;
  lastInvokedAt: number | null;
}

export function readToolCounters(toolNames: string[]): ToolCounterSnapshot[] {
  return toolNames.map((name) => ({
    name,
    count: counts.get(name) ?? 0,
    lastInvokedAt: lastInvokedAt.get(name) ?? null,
  }));
}
