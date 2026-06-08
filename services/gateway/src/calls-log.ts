// In-process ring buffer of recent Gateway.callTool outcomes. Surfaced by
// the gateway ops view (:9180) so the demo can point at one screen and see
// every routing decision in the last minute.
//
// Process-local; resets on restart. Writes are made deterministic by
// wrapping in `ctx.run` at the call site (see logCall in gateway.ts), so
// the same invocation can't double-log on replay.

export interface CallLogEntry {
  timestampMs: number;
  kind: "tool" | "llm";
  toolName: string;         // for kind="llm" this carries the purpose
  status: "ok" | "needs_approval" | "blocked";
  source?: string;          // for blocked / needs_approval: which middleware
  reason?: string;          // human-readable summary
  tenantId: string;
  sessionId: string;
  // The agent turn this call belongs to. One Session.sendMessage invocation
  // mints a fresh traceId on its CallerIdentity and threads it through every
  // downstream gateway call — so all the rows produced by one "send" click
  // share a traceId and group together in the recent-calls view.
  traceId?: string;
  costCents?: number;
  waitedMs?: number;        // accumulated time spent in rate-limit waits
  appealable?: boolean;     // true when this was a block_appealable
  invocationId?: string;    // Restate invocation id for the deep-link to admin UI
}

const buf: CallLogEntry[] = [];
const MAX = 30;

export function recordCall(e: CallLogEntry): void {
  buf.push(e);
  if (buf.length > MAX) buf.shift();
}

// Newest first.
export function recentCalls(): CallLogEntry[] {
  return [...buf].reverse();
}
