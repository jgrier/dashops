import * as restate from "@restatedev/restate-sdk";
import { gateway } from "./gateway.js";
import { toolRegistry } from "./tool-registry.js";
import { costLedger } from "./cost-ledger.js";

const port = parseInt(process.env.PORT ?? "9080", 10);
restate.serve({
  services: [gateway, toolRegistry, costLedger],
  port,
});
console.log(`Gateway (with ToolRegistry + CostLedger) listening on :${port}`);
