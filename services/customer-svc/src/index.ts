import * as restate from "@restatedev/restate-sdk";
import { selfRegisterTools, readToolCounters, type ToolCounterSnapshot } from "@dashops/shared";
import { customerLookup } from "./customer-lookup.js";
import { applyCredit } from "./apply-credit.js";
import { customerOutreach } from "./customer-outreach.js";

const port = parseInt(process.env.PORT ?? "9082", 10);
const ownedTools = ["customer_lookup", "apply_credit", "customer_outreach"];

const ops = restate.service({
  name: "CustomerSvc",
  handlers: {
    toolCounters: async (_ctx: restate.Context): Promise<ToolCounterSnapshot[]> => {
      return readToolCounters(ownedTools);
    },
    buggyMode: async (_ctx: restate.Context): Promise<{ on: boolean }> => {
      return { on: process.env.BUGGY_MODE === "1" };
    },
  },
});

restate.serve({
  services: [customerLookup, applyCredit, customerOutreach, ops],
  port,
});
console.log(`customer-svc listening on :${port}`);

selfRegisterTools([
  {
    name: "customer_lookup",
    serviceName: "CustomerLookup",
    handlerName: "execute",
    description: "Look up a customer profile by ID",
    configuredCostCents: 0,
    rateLimit: { perMinute: 60 },
  },
  {
    name: "apply_credit",
    serviceName: "ApplyCredit",
    handlerName: "execute",
    description: "Apply a credit to a customer",
    configuredCostCents: 0,
    rateLimit: { perMinute: 10 },
  },
  {
    name: "customer_outreach",
    serviceName: "CustomerOutreach",
    handlerName: "execute",
    description: "Send an outreach message",
    configuredCostCents: 0,
    rateLimit: { perMinute: 10 },
  },
]);
