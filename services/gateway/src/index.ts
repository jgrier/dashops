import * as restate from "@restatedev/restate-sdk";
import { gateway } from "./gateway.js";
import { toolRegistry } from "./tool-registry.js";
import { costLedger } from "./cost-ledger.js";
import { tokenBucket } from "./token-bucket.js";

const port = parseInt(process.env.PORT ?? "9080", 10);
restate.serve({
  services: [gateway, toolRegistry, costLedger, tokenBucket],
  port,
});
console.log(`Gateway (with ToolRegistry, CostLedger, TokenBucket) listening on :${port}`);
