import * as restate from "@restatedev/restate-sdk";
import { gateway } from "./gateway.js";
import { toolRegistry } from "./tool-registry.js";
import { costLedger } from "./cost-ledger.js";
import { tokenBucket } from "./token-bucket.js";

// Gateway process: pure Restate handlers only. The ops view (middleware
// chain, registry table, rate-limit buckets, cost ledger, recent calls)
// is rendered in the supervisor's BFF; it fetches the data it needs from
// the handlers exposed here (recentCalls on Gateway, plus the existing
// shared handlers on ToolRegistry, CostLedger, TokenBucket).

const port = parseInt(process.env.PORT ?? "9080", 10);

restate.serve({
  services: [gateway, toolRegistry, costLedger, tokenBucket],
  port,
});
console.log(`Gateway (Gateway, ToolRegistry, CostLedger, TokenBucket) listening on :${port}`);
