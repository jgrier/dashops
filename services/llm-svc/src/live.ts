// Live LLM caller — invoked when ANTHROPIC_API_KEY is set. Skeleton today;
// the SDK call gets wired once the demo wants to flip from deterministic
// to real model output. The key insight that makes this commit valuable
// even before live mode lands: the gateway sits in front of this call,
// so every guardrail/rate-limit/cost-tracking concern is policy-applied
// at one place — regardless of which purpose triggered the call.

import type { CallLLMRequest, CallLLMResponse } from "@dashops/shared";

export async function runLive(req: CallLLMRequest): Promise<CallLLMResponse> {
  // TODO Phase 6: build per-purpose prompt, call @anthropic-ai/sdk, parse,
  // compute costCents from usage × per-model rate. For now: fall back to
  // stub behavior with a marker so the ops view can tell live mode tried
  // and gave up.
  const { runStub } = await import("./stubs.js");
  const stub = runStub(req);
  return { ...stub, mode: "live" };
}
