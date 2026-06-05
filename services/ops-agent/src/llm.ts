// Stub "LLM" for Phase 1: pattern-matches the user's intent against a fixed
// set of investigation flows. Deterministic. The intent here is to make the
// reagent loop legible to the demo viewer: one user message produces a
// sequence of thoughts and tool calls that land somewhere coherent.
//
// Live mode (Anthropic API call) will be wired in Phase 6 once the loop is
// proven to work end-to-end with the stub.

import type { SessionMessage } from "@dashops/shared";

export interface LLMStep {
  thought: string;
  next:
    | { type: "tool_call"; tool: string; params: Record<string, unknown> }
    | { type: "final"; reply: string };
}

export function planNext(messages: SessionMessage[]): LLMStep {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return { thought: "no input", next: { type: "final", reply: "Tell me what you're looking at." } };
  }

  // What tools have been called *since* the last user message?
  const lastUserIdx = messages.lastIndexOf(lastUser);
  const stepsSince = messages.slice(lastUserIdx + 1);
  const calledTools = stepsSince.filter((m) => m.role === "tool").map((m) => m.toolName!);

  const text = lastUser.content;
  const deliveryMatch = text.match(/delivery\s*#?(\d+)/i);
  const searchHint = /\b(find|search|similar|complaints?)\b/i.test(text) && !deliveryMatch;

  // -- Search-for-similar-complaints flow -----------------------------------
  if (searchHint) {
    if (!calledTools.includes("semantic_search")) {
      return {
        thought: `Let me search for similar past complaints.`,
        next: {
          type: "tool_call",
          tool: "semantic_search",
          // Drop the raw user text into the query — this is the Phase 2 PII demo:
          // if the operator's question contains a phone number etc., the guardrail
          // will flag it here.
          params: { query: text },
        },
      };
    }
    const searchResult = stepsSince.find((m) => m.toolName === "semantic_search")
      ?.toolResult as Record<string, unknown> | undefined;
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

  // -- Investigate-a-delivery flow ------------------------------------------
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
        next: {
          type: "tool_call",
          tool: "customer_lookup",
          params: { customer_id: deliveryResult.customerId },
        },
      };
    }

    // Synthesize.
    const delivery = deliveryResult as Record<string, unknown> | undefined;
    const escalation = stepsSince.find((m) => m.toolName === "escalation_history")
      ?.toolResult as Record<string, unknown> | undefined;
    const customer = stepsSince.find((m) => m.toolName === "customer_lookup")
      ?.toolResult as Record<string, unknown> | undefined;

    return {
      thought: `I have what I need. Putting the summary together.`,
      next: {
        type: "final",
        reply: synthesizeDeliveryReport(deliveryId, delivery, escalation, customer),
      },
    };
  }

  // -- Catch-all ------------------------------------------------------------
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
