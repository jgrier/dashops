import * as restate from "@restatedev/restate-sdk";

// Classic token bucket as a Restate Virtual Object, keyed by an arbitrary
// resource identifier. The gateway uses three keys per call to stack rate
// limits hierarchically:
//   global:<tool_name>
//   tenant:<tenant_id>
//   tenant_tool:<tenant_id>:<tool_name>
//
// Caller (gateway) passes capacity + refillRate on every acquire so the
// bucket doesn't need a separate configure step. The first call seeds
// state; subsequent calls happily accept the same config.

export interface AcquireRequest {
  tokens: number;            // number to acquire (typically 1)
  capacity: number;          // bucket max
  refillRate: number;        // tokens per second
}

export interface AcquireResponse {
  acquired: boolean;
  waitMs: number;            // if !acquired, sleep this long then retry
  tokensLeft: number;
}

export const tokenBucket = restate.object({
  name: "TokenBucket",
  handlers: {
    acquire: async (
      ctx: restate.ObjectContext,
      req: AcquireRequest
    ): Promise<AcquireResponse> => {
      const now = await ctx.date.now();
      const lastRefill = (await ctx.get<number>("lastRefillMs")) ?? now;
      let tokens = (await ctx.get<number>("tokens")) ?? req.capacity;

      const elapsedSec = Math.max(0, (now - lastRefill) / 1000);
      tokens = Math.min(req.capacity, tokens + elapsedSec * req.refillRate);

      // Persist capacity + refillRate so the shared state handler can compute
      // a live token count without the caller having to pass them in. Writes
      // are idempotent — same call site sends the same values every time.
      ctx.set("capacity", req.capacity);
      ctx.set("refillRate", req.refillRate);

      if (tokens >= req.tokens) {
        tokens -= req.tokens;
        ctx.set("tokens", tokens);
        ctx.set("lastRefillMs", now);
        return { acquired: true, waitMs: 0, tokensLeft: tokens };
      }

      const deficit = req.tokens - tokens;
      const waitMs = Math.ceil((deficit / req.refillRate) * 1000);
      ctx.set("tokens", tokens);
      ctx.set("lastRefillMs", now);
      return { acquired: false, waitMs, tokensLeft: tokens };
    },

    // Live state: applies the same refill math `acquire` would, so the
    // returned `tokens` reflects what's available NOW, not whatever was
    // left over the last time someone acquired. Lets the ops view show
    // the bucket trickling back up between bursts.
    state: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext) => {
        const storedTokens = await ctx.get<number>("tokens");
        const lastRefill = await ctx.get<number>("lastRefillMs");
        const capacity = await ctx.get<number>("capacity");
        const refillRate = await ctx.get<number>("refillRate");

        // Never been touched — buckets only come into existence via acquire.
        if (storedTokens === null || lastRefill === null || capacity === null || refillRate === null) {
          return {
            key: ctx.key,
            tokens: null,
            lastRefillMs: null,
            capacity: null,
            refillRate: null,
            nextRefillMs: null,
          };
        }

        const now = await ctx.date.now();
        const elapsedSec = Math.max(0, (now - lastRefill) / 1000);
        const live = Math.min(capacity, storedTokens + elapsedSec * refillRate);

        // ms until the bucket gains its next whole token (or null if full).
        let nextRefillMs: number | null = null;
        if (live < capacity) {
          const tokensTillNext = Math.ceil(live) - live || 1;
          nextRefillMs = Math.max(0, Math.ceil((tokensTillNext / refillRate) * 1000));
        }

        return {
          key: ctx.key,
          tokens: live,
          lastRefillMs: lastRefill,
          capacity,
          refillRate,
          nextRefillMs,
        };
      }
    ),
  },
});
