// Per-purpose invocation counters for the llm-svc ops view. Process-local;
// resets on restart. Surfaces "the planner has called 14 times,
// the PII classifier 3 times" on one screen.

const counts = new Map<string, number>();
const lastAt = new Map<string, number>();
const lastCostCents = new Map<string, number>();

export function bumpPurposeCount(purpose: string, costCents = 0): void {
  counts.set(purpose, (counts.get(purpose) ?? 0) + 1);
  lastAt.set(purpose, Date.now());
  if (costCents > 0) lastCostCents.set(purpose, costCents);
}

export interface PurposeSnapshot {
  purpose: string;
  count: number;
  lastAt: number | null;
  lastCostCents: number | null;
}

export function readPurposeCounters(): PurposeSnapshot[] {
  const purposes = new Set<string>([
    "agent-planning",
    "guardrail-pii",
    "semantic-search",
    ...counts.keys(),
  ]);
  return [...purposes].map((p) => ({
    purpose: p,
    count: counts.get(p) ?? 0,
    lastAt: lastAt.get(p) ?? null,
    lastCostCents: lastCostCents.get(p) ?? null,
  }));
}
