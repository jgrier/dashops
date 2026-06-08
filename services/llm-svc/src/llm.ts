import * as restate from "@restatedev/restate-sdk";
import type { CallLLMRequest, CallLLMResponse } from "@dashops/shared";
import { runStub } from "./stubs.js";
import { runLive } from "./live.js";
import { bumpPurposeCount } from "./counters.js";

const LIVE_MODE = !!process.env.ANTHROPIC_API_KEY;

// Single Restate service in front of every LLM call. The gateway dispatches
// here through its callLLM handler, so guardrails / rate limits / cost
// tracking are applied at one place regardless of which agent or middleware
// kicked the call off.
export const llmService = restate.service({
  name: "LLMService",
  handlers: {
    complete: async (
      _ctx: restate.Context,
      req: CallLLMRequest
    ): Promise<CallLLMResponse> => {
      const result = LIVE_MODE ? await runLive(req) : runStub(req);
      bumpPurposeCount(req.purpose, result.costCents);
      return result;
    },
  },
});
