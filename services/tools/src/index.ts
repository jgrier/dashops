import * as restate from "@restatedev/restate-sdk";
import { deliveryLookup } from "./delivery-lookup.js";
import { customerLookup } from "./customer-lookup.js";
import { escalationHistory } from "./escalation-history.js";

const port = parseInt(process.env.PORT ?? "9082", 10);
restate.serve({
  services: [deliveryLookup, customerLookup, escalationHistory],
  port,
});
console.log(
  `Tools (DeliveryLookup, CustomerLookup, EscalationHistory) listening on :${port}`
);
