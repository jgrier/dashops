import * as restate from "@restatedev/restate-sdk";
import { deliveryLookup } from "./delivery-lookup.js";
import { customerLookup } from "./customer-lookup.js";
import { escalationHistory } from "./escalation-history.js";
import { semanticSearch } from "./semantic-search.js";

const port = parseInt(process.env.PORT ?? "9082", 10);
restate.serve({
  services: [deliveryLookup, customerLookup, escalationHistory, semanticSearch],
  port,
});
console.log(
  `Tools (DeliveryLookup, CustomerLookup, EscalationHistory, SemanticSearch) listening on :${port}`
);
