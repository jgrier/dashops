import * as restate from "@restatedev/restate-sdk";
import { piiGuardrail } from "./pii.js";

const port = parseInt(process.env.PORT ?? "9084", 10);
restate.serve({ services: [piiGuardrail], port });
console.log(`Guardrails (PIIGuardrail) listening on :${port}`);
