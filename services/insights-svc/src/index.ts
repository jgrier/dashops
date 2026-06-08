import * as restate from "@restatedev/restate-sdk";
import { selfRegisterTools } from "@dashops/shared";
import { semanticSearch } from "./semantic-search.js";
import { merchantStatus } from "./merchant-status.js";

const port = parseInt(process.env.PORT ?? "9086", 10);

restate.serve({
  services: [semanticSearch, merchantStatus],
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
