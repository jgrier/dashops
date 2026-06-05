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

      // Refill based on elapsed time.
      const elapsedSec = Math.max(0, (now - lastRefill) / 1000);
      tokens = Math.min(req.capacity, tokens + elapsedSec * req.refillRate);

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

    state: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext) => ({
        key: ctx.key,
        tokens: (await ctx.get<number>("tokens")) ?? null,
        lastRefillMs: (await ctx.get<number>("lastRefillMs")) ?? null,
      })
    ),
  },
});
