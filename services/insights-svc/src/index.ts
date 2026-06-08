import * as restate from "@restatedev/restate-sdk";
import { selfRegisterTools, readToolCounters, type ToolCounterSnapshot } from "@dashops/shared";
import { semanticSearch } from "./semantic-search.js";
import { merchantStatus } from "./merchant-status.js";

const port = parseInt(process.env.PORT ?? "9086", 10);
const ownedTools = ["semantic_search", "merchant_status"];

const ops = restate.service({
  name: "InsightsSvc",
  handlers: {
    toolCounters: async (_ctx: restate.Context): Promise<ToolCounterSnapshot[]> => {
      return readToolCounters(ownedTools);
    },
  },
});

restate.serve({
  services: [semanticSearch, merchantStatus, ops],
  port,
});
console.log(`insights-svc listening on :${port}`);

selfRegisterTools([
  {
    name: "semantic_search",
    serviceName: "SemanticSearch",
    handlerName: "execute",
    description: "Find similar past complaints",
    configuredCostCents: 5,
    rateLimit: { perMinute: 30 },
  },
  {
    name: "merchant_status",
    serviceName: "MerchantStatus",
    handlerName: "execute",
    description: "Get merchant operational status",
    configuredCostCents: 0,
    rateLimit: { perMinute: 6 },
  },
]);
