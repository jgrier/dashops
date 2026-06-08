import * as restate from "@restatedev/restate-sdk";
import { selfRegisterTools } from "@dashops/shared";
import { deliveryLookup } from "./delivery-lookup.js";
import { escalationHistory } from "./escalation-history.js";

const port = parseInt(process.env.PORT ?? "9081", 10);

restate.serve({
  services: [deliveryLookup, escalationHistory],
  port,
});
console.log(`delivery-svc listening on :${port}`);

// Self-register the tools we own with the gateway's ToolRegistry.
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
