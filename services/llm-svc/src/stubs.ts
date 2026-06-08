// Deterministic stub responses for each LLM purpose. These reproduce what
// the in-process planner, PII regex, and canned semantic-search returned
// before the refactor — same demo behavior, but now centralized so the
// gateway sits in front of every LLM-shaped call.
//
// When ANTHROPIC_API_KEY is set, live.ts takes over (Phase 6); these stubs
// stay as the deterministic fallback for development.

import type { CallLLMRequest, CallLLMResponse, SessionMessage } from "@dashops/shared";

export function runStub(req: CallLLMRequest): CallLLMResponse {
  switch (req.purpose) {
    case "agent-planning":
      return plannerStub(req);
    case "guardrail-pii":
      return piiStub(req);
    case "semantic-search":
      return semanticSearchStub(req);
    default:
      return {
        status: "ok",
        purpose: req.purpose,
        content: null,
        costCents: 0,
        mode: "stub",
      };
  }
}

// -- Agent planner ---------------------------------------------------------
// Pattern-matches the latest user message + prior tool results to decide the
// next step. Returns an LLMStep-shaped object as content.

function plannerStub(req: CallLLMRequest): CallLLMResponse {
  const messages = ((req.params?.messages as SessionMessage[]) ?? []) as SessionMessage[];
  const step = planNext(messages);
  return {
    status: "ok",
    purpose: req.purpose,
    content: step,
    costCents: 2,                       // notional planner cost
    mode: "stub",
  };
}

interface LLMStep {
  thought: string;
  next:
    | { type: "tool_call"; tool: string; params: Record<string, unknown> }
    | { type: "final"; reply: string };
}

function planNext(messages: SessionMessage[]): LLMStep {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return { thought: "no input", next: { type: "final", reply: "Tell me what you're looking at." } };
  }

  const lastUserIdx = messages.lastIndexOf(lastUser);
  const stepsSince = messages.slice(lastUserIdx + 1);
  const calledTools = stepsSince.filter((m) => m.role === "tool").map((m) => m.toolName!);

  const text = lastUser.content;
  const deliveryMatch = text.match(/delivery\s*#?(\d+)/i);
  const merchantBatchMatch = text.match(/merchants?\s+for\s+deliveries?\s+([\d,\s]+)/i);
  const searchHint = /\b(find|search|similar|complaints?)\b/i.test(text) && !deliveryMatch && !merchantBatchMatch;
  const actionHint =
    /\b(apolog(?:ize|y)|credit|outreach|refund)\b/i.test(text) ||
    /\$\d+(\.\d+)?/.test(text) ||
    /\b\d+\s*dollars?\b/i.test(text);
  const creditAmountMatch =
    text.match(/\$(\d+(?:\.\d{1,2})?)/) ?? text.match(/(\d+(?:\.\d{1,2})?)\s*dollars?/i);

  // Merchant-batch flow (rate-limit demo)
  if (merchantBatchMatch) {
    const ids = merchantBatchMatch[1].split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const merchantIdForDelivery: Record<string, string> = {
      "12345": "M-44",
      "12346": "M-08",
      "12399": "M-21",
    };
    const merchantIds = ids.map((d) => merchantIdForDelivery[d]).filter(Boolean);

    const calledCount = stepsSince.filter((m) => m.toolName === "merchant_status").length;
    if (calledCount < merchantIds.length) {
      const next = merchantIds[calledCount];
      return {
        thought:
          calledCount === 0
            ? `Pulling merchant status for ${merchantIds.length} merchants in sequence.`
            : `Continuing — merchant ${next}.`,
        next: { type: "tool_call", tool: "merchant_status", params: { merchant_id: next } },
      };
    }

    const statuses = stepsSince.filter((m) => m.toolName === "merchant_status").map((m) => m.toolResult);
    return {
      thought: `Got all merchant statuses. Summarizing.`,
      next: {
        type: "final",
        reply:
          `Merchant status for ${ids.length} deliveries:\n\n` +
          statuses
            .map(
              (s, i) =>
                `• delivery ${ids[i]} → ${(s as any).merchantId}: ${
                  (s as any).open ? `OPEN (lag ${(s as any).kitchenLagMin}m)` : "CLOSED"
                }`
            )
            .join("\n"),
      },
    };
  }

  // Search-for-similar-complaints flow
  if (searchHint) {
    if (!calledTools.includes("semantic_search")) {
      return {
        thought: `Let me search for similar past complaints.`,
        next: { type: "tool_call", tool: "semantic_search", params: { query: text } },
      };
    }
    const searchResult = stepsSince.find((m) => m.toolName === "semantic_search")?.toolResult as
      | Record<string, unknown>
      | undefined;
    return {
      thought: `Summarizing what I found.`,
      next: {
        type: "final",
        reply: searchResult
          ? `Found ${(searchResult as any).count} similar complaints. Top match: delivery #${
              ((searchResult as any).results?.[0] ?? {}).deliveryId
            } — ${((searchResult as any).results?.[0] ?? {}).summary}.`
          : "No results.",
      },
    };
  }

  // Investigate-a-delivery flow
  if (deliveryMatch) {
    const deliveryId = deliveryMatch[1];

    if (!calledTools.includes("delivery_lookup")) {
      return {
        thought: `Let me start by pulling up delivery #${deliveryId}.`,
        next: { type: "tool_call", tool: "delivery_lookup", params: { delivery_id: deliveryId } },
      };
    }

    if (!calledTools.includes("escalation_history")) {
      return {
        thought: `Checking the escalation history for this delivery.`,
        next: { type: "tool_call", tool: "escalation_history", params: { delivery_id: deliveryId } },
      };
    }

    const deliveryResult = stepsSince.find((m) => m.toolName === "delivery_lookup")?.toolResult as
      | { customerId?: string }
      | undefined;
    if (deliveryResult?.customerId && !calledTools.includes("customer_lookup")) {
      return {
        thought: `Looking up the customer's profile so I have context on who was affected.`,
        next: { type: "tool_call", tool: "customer_lookup", params: { customer_id: deliveryResult.customerId } },
      };
    }

    const delivery = deliveryResult as Record<string, unknown> | undefined;
    const customer = stepsSince.find((m) => m.toolName === "customer_lookup")?.toolResult as
      | Record<string, unknown>
      | undefined;
    const escalation = stepsSince.find((m) => m.toolName === "escalation_history")?.toolResult as
      | Record<string, unknown>
      | undefined;

    if (actionHint && customer && !calledTools.includes("apply_credit")) {
      const amountCents = creditAmountMatch ? Math.round(parseFloat(creditAmountMatch[1]) * 100) : 2000;
      return {
        thought: `Applying a $${(amountCents / 100).toFixed(2)} credit to ${
          (customer as any).name
        } given the unresolved escalation.`,
        next: {
          type: "tool_call",
          tool: "apply_credit",
          params: {
            customer_id: (customer as any).customerId,
            amount_cents: amountCents,
            reason: `compensation for delivery #${deliveryId} (3 prior escalations, unsatisfied)`,
          },
        },
      };
    }

    if (actionHint && customer && !calledTools.includes("customer_outreach")) {
      return {
        thought: `Sending the apology message to the customer.`,
        next: {
          type: "tool_call",
          tool: "customer_outreach",
          params: {
            customer_id: (customer as any).customerId,
            template: "apology_with_credit",
            template_params: { delivery_id: deliveryId },
          },
        },
      };
    }

    if (actionHint) {
      const credit = stepsSince.find((m) => m.toolName === "apply_credit")?.toolResult as
        | Record<string, unknown>
        | undefined;
      const outreach = stepsSince.find((m) => m.toolName === "customer_outreach")?.toolResult as
        | Record<string, unknown>
        | undefined;
      return {
        thought: `Done. Wrapping up.`,
        next: {
          type: "final",
          reply: `**Action complete for delivery #${deliveryId}.**\n\n${
            credit ? `• Credited $${(((credit as any).amountCents ?? 0) / 100).toFixed(2)} to ${(customer as any)?.name ?? "the customer"} (credit id ${(credit as any).creditId}).\n` : ""
          }${
            outreach ? `• Sent apology_with_credit message (id ${(outreach as any).messageId}).\n` : ""
          }`,
        },
      };
    }

    return {
      thought: `I have what I need. Putting the summary together.`,
      next: { type: "final", reply: synthesizeDeliveryReport(deliveryId, delivery, escalation, customer) },
    };
  }

  return {
    thought: "Not sure what to look at — can you give me a delivery ID?",
    next: {
      type: "final",
      reply:
        "I can investigate a delivery if you give me an ID — e.g. *what happened with delivery #12345*?",
    },
  };
}

function synthesizeDeliveryReport(
  deliveryId: string,
  delivery: Record<string, unknown> | undefined,
  escalation: Record<string, unknown> | undefined,
  customer: Record<string, unknown> | undefined
): string {
  if (!delivery || (delivery as any).error) {
    return `I couldn't find delivery #${deliveryId}.`;
  }
  const issues = ((delivery as any).issues as string[]) ?? [];
  const issuesLine = issues.length
    ? `**Issues recorded:** ${issues.join(", ")}.`
    : `**Issues recorded:** none.`;
  const escSummary = (escalation as any)?.summary ?? {};
  const unsat = escSummary.unsatisfiedSignal === true;
  const escLine = escSummary.count
    ? `**Escalations:** ${escSummary.count}, last satisfaction ${escSummary.lastSatisfaction}/5${
        unsat ? " — customer was not satisfied" : ""
      }.`
    : `**Escalations:** none.`;
  const custLine = customer
    ? `**Customer:** ${(customer as any).name} (${(customer as any).loyaltyTier}, ${
        (customer as any).recentOrderCount
      } recent orders).`
    : "";

  return [
    `**Delivery #${deliveryId}** — status: ${(delivery as any).status}.`,
    issuesLine,
    escLine,
    custLine,
    unsat
      ? `\n→ The escalation pattern suggests an unresolved customer issue. A corrective action (apology + credit) would be reasonable here.`
      : `\n→ Nothing flagged that requires further action.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// -- PII classifier --------------------------------------------------------
// Today's "LLM-classified" PII check is a regex pre-screen. Live mode (Phase 6)
// would replace this body with a real classifier call.

const PHONE_RE = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){2}\d{4}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CC_RE = /\b(?:\d[ -]*?){13,19}\b/g;

function piiStub(req: CallLLMRequest): CallLLMResponse {
  const params = (req.params?.params as Record<string, unknown>) ?? {};
  const blob = JSON.stringify(params);
  const detected: Array<{ kind: string; sample: string }> = [];

  const phoneMatches = blob.match(PHONE_RE);
  if (phoneMatches?.length) detected.push({ kind: "phone", sample: phoneMatches[0] });

  const ssnMatches = blob.match(SSN_RE);
  if (ssnMatches?.length) detected.push({ kind: "ssn", sample: ssnMatches[0] });

  const ccMatches = blob.match(CC_RE);
  if (ccMatches?.length) {
    const filtered = ccMatches.filter(
      (m) => !phoneMatches?.includes(m) && !ssnMatches?.includes(m)
    );
    if (filtered.length) detected.push({ kind: "credit_card_candidate", sample: filtered[0] });
  }

  const flagged = detected.length > 0;
  return {
    status: "ok",
    purpose: req.purpose,
    content: {
      flagged,
      reason: flagged
        ? `Detected possible PII in tool params: ${detected.map((d) => `${d.kind} (${d.sample})`).join("; ")}`
        : undefined,
      detected: flagged ? detected : undefined,
    },
    costCents: 0,                       // stub regex is free; live mode would charge here
    mode: "stub",
  };
}

// -- Semantic search -------------------------------------------------------
// Returns canned "similar complaints". Live mode would call an embedding-based
// retrieval LLM. Cost is reported here so the cost-ledger demo lights up.

function semanticSearchStub(req: CallLLMRequest): CallLLMResponse {
  const query = String(req.params?.query ?? "");
  const results = [
    { deliveryId: "12101", summary: "cold food, refunded 25%", similarity: 0.82 },
    { deliveryId: "12277", summary: "missing items, full credit issued", similarity: 0.71 },
    { deliveryId: "12318", summary: "late delivery, customer offered loyalty points", similarity: 0.66 },
  ];
  return {
    status: "ok",
    purpose: req.purpose,
    content: { query, results, count: results.length },
    costCents: 5,
    mode: "stub",
  };
}
