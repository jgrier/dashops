import * as restate from "@restatedev/restate-sdk";
import { llmService } from "./llm.js";

const port = parseInt(process.env.PORT ?? "9087", 10);
const LIVE_MODE = !!process.env.ANTHROPIC_API_KEY;

restate.serve({ services: [llmService], port });
console.log(`llm-svc listening on :${port}  (mode=${LIVE_MODE ? "LIVE" : "stub"})`);
