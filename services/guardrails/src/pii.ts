import * as restate from "@restatedev/restate-sdk";

// PII guardrail: inspects the JSON-serialized params of a pending tool call
// and flags if PII patterns are detected.
//
// Stub mode (default): regex pre-screen for phone numbers, SSN, credit cards.
// Live mode (ANTHROPIC_API_KEY set, Phase 6): LLM classifier for higher
// fidelity. Either way the gateway calls this as ordinary middleware.

export interface PIICheckRequest {
  // arbitrary tool params being inspected
  params: Record<string, unknown>;
  toolName: string;
}

export interface PIICheckResponse {
  flagged: boolean;
  reason?: string;
  detected?: Array<{ kind: string; sample: string }>;
  costCents: number;
}

// US phone (xxx-xxx-xxxx, (xxx) xxx-xxxx, +1 xxx ...).
const PHONE_RE = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){2}\d{4}/g;
// SSN (xxx-xx-xxxx).
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// 13-19 digit numbers that could be credit cards.
const CC_RE = /\b(?:\d[ -]*?){13,19}\b/g;

export const piiGuardrail = restate.service({
  name: "PIIGuardrail",
  handlers: {
    check: async (
      _ctx: restate.Context,
      req: PIICheckRequest
    ): Promise<PIICheckResponse> => {
      const blob = JSON.stringify(req.params ?? {});
      const detected: Array<{ kind: string; sample: string }> = [];

      const phoneMatches = blob.match(PHONE_RE);
      if (phoneMatches?.length) {
        detected.push({ kind: "phone", sample: phoneMatches[0] });
      }
      const ssnMatches = blob.match(SSN_RE);
      if (ssnMatches?.length) {
        detected.push({ kind: "ssn", sample: ssnMatches[0] });
      }
      const ccMatches = blob.match(CC_RE);
      if (ccMatches?.length) {
        // Heuristic: filter out the things already matched as phone/SSN.
        const filtered = ccMatches.filter(
          (m) => !phoneMatches?.includes(m) && !ssnMatches?.includes(m)
        );
        if (filtered.length) {
          detected.push({ kind: "credit_card_candidate", sample: filtered[0] });
        }
      }

      if (detected.length === 0) {
        return { flagged: false, costCents: 0 };
      }

      return {
        flagged: true,
        reason: `Detected possible PII in tool params: ${detected
          .map((d) => `${d.kind} (${d.sample})`)
          .join("; ")}`,
        detected,
        costCents: 0,                       // stub regex pre-screen; live LLM mode would charge here
      };
    },
  },
});
