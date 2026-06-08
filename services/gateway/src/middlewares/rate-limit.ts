import * as restate from "@restatedev/restate-sdk";
import type { Middleware, MiddlewareResult, MiddlewareContext } from "./types.js";

type AR = { acquired: boolean; waitMs: number; tokensLeft: number };

// Hierarchical token-bucket rate limiter. Stacks three buckets:
//   global:<tool>          — protects the downstream from total overwhelm
//   tenant:<tenant_id>     — fairness across tools for one tenant
//   tenant_tool:<...>:<...> — per-(tenant,tool); driven by the registration
//
// On any bucket exhausted, returns `wait` so the gateway sleeps then
// re-checks this middleware from the top (cheap; each `acquire` is fast).
export const rateLimitMW: Middleware = {
  name: "rate-limit",
  async check(
    ctx: restate.Context,
    mctx: MiddlewareContext
  ): Promise<MiddlewareResult> {
    const req = mctx.request;
    const perTenantTool = mctx.registration.rateLimit?.perMinute ?? 60;
    const buckets = [
      { key: `global:${req.toolName}`, capacity: 60, refillRate: 60 / 60 },
      { key: `tenant:${req.identity.tenantId}`, capacity: 120, refillRate: 120 / 60 },
      {
        key: `tenant_tool:${req.identity.tenantId}:${req.toolName}`,
        capacity: perTenantTool,
        refillRate: perTenantTool / 60,
      },
    ];

    for (const b of buckets) {
      const res = await ctx.genericCall<
        { tokens: number; capacity: number; refillRate: number },
        AR
      >({
        service: "TokenBucket",
        method: "acquire",
        key: b.key,
        parameter: { tokens: 1, capacity: b.capacity, refillRate: b.refillRate },
        inputSerde: restate.serde.json,
        outputSerde: restate.serde.json,
        name: `mw · rate-limit · ${b.key}`,
      });
      if (!res.acquired) {
        // Bubble up — gateway will sleep and re-check the whole chain from
        // this middleware. Earlier buckets may have to be reacquired; for
        // demo purposes the over-acquire is acceptable.
        return { kind: "wait", ms: res.waitMs };
      }
    }
    return { kind: "pass" };
  },
};
