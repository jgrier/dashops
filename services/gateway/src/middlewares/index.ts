import type { Middleware } from "./types.js";
import { piiGuardrailMW } from "./pii-guardrail.js";
import { approvalPolicyMW } from "./approval-policy.js";
import { rateLimitMW } from "./rate-limit.js";

// Order matters. Each middleware sees the request in this order and can
// short-circuit before later ones run. PII first (cheap regex / LLM
// classifier; rejects malformed data early), then approval-policy (which
// can short-circuit before we burn a token-bucket slot on a call that's
// going to suspend anyway), then rate-limit (which sleeps durably when
// buckets are empty).
export const gatewayMiddlewares: Middleware[] = [
  piiGuardrailMW,
  approvalPolicyMW,
  rateLimitMW,
];

export type { Middleware, MiddlewareResult, MiddlewareContext } from "./types.js";
