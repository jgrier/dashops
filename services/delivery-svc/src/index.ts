import * as restate from "@restatedev/restate-sdk";
import { selfRegisterTools, readToolCounters, type ToolCounterSnapshot } from "@dashops/shared";
import { deliveryLookup } from "./delivery-lookup.js";
import { escalationHistory } from "./escalation-history.js";

const port = parseInt(process.env.PORT ?? "9081", 10);
const ownedTools = ["delivery_lookup", "escalation_history"];

// Narrow data-only ops handler. No HTML, no notion of "sections" — just the
// in-process counter snapshot. The BFF queries this when it renders the
// /ops/delivery-svc page in the web tier.
const ops = restate.service({
  name: "DeliverySvc",
  handlers: {
    toolCounters: async (_ctx: restate.Context): Promise<ToolCounterSnapshot[]> => {
      return readToolCounters(ownedTools);
    },
  },
});

restate.serve({
  services: [deliveryLookup, escalationHistory, ops],
  port,
});
console.log(`delivery-svc listening on :${port}`);

selfRegisterTools([
  {
    name: "delivery_lookup",
    serviceName: "DeliveryLookup",
    handlerName: "execute",
    description: "Look up a delivery by ID",
    configuredCostCents: 0,
    rateLimit: { perMinute: 60 },
  },
  {
    name: "escalation_history",
    serviceName: "EscalationHistory",
    handlerName: "execute",
    description: "Recent escalations for a delivery",
    configuredCostCents: 0,
    rateLimit: { perMinute: 60 },
  },
]);
