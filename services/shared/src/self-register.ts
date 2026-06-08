import type { ToolRegistration } from "./index.js";

const INGRESS = process.env.RESTATE_INGRESS ?? "http://localhost:8080";

// Retry budget: registry comes up alongside the gateway. In normal boot the
// gateway is already serving by the time we call, but on a cold start we may
// race it. 30s of 1s polling is plenty.
const MAX_ATTEMPTS = 30;

async function registerOne(reg: ToolRegistration): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const r = await fetch(`${INGRESS}/ToolRegistry/default/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reg),
      });
      if (r.ok) {
        console.log(`  ✓ registered tool ${reg.name} → ${reg.serviceName}`);
        return;
      }
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  console.error(`  ✗ failed to register ${reg.name} after ${MAX_ATTEMPTS}s: ${String(lastErr)}`);
}

// Self-register a service's tools with the gateway's ToolRegistry.
// Call after `restate.serve(...)` starts listening — the call out is async
// and won't block the SDK from accepting invocations.
export function selfRegisterTools(tools: ToolRegistration[]): void {
  if (tools.length === 0) return;
  void (async () => {
    // small delay so the registering service's own SDK is ready to handle
    // any back-references before the registry starts routing to it
    await new Promise((res) => setTimeout(res, 500));
    for (const t of tools) {
      await registerOne(t);
    }
  })();
}
