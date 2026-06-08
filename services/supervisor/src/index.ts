import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { services } from "./config.js";
import * as procs from "./procs.js";
import { startTui } from "./tui.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..", "..");

// Resolve each spec's cwd to an absolute path before spawning.
for (const s of services) {
  if (s.cwd) s.cwd = path.resolve(ROOT, s.cwd);
}

procs.init(services);

const ADMIN_REGISTER = process.env.RESTATE_ADMIN ?? "http://localhost:9070";

// After Restate is healthy and a service is listening, post its endpoint to
// Restate's /deployments. Skipped for HTTP-only children like the BFF and
// for restate-server itself.
async function registerDeployment(port: number, name: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${ADMIN_REGISTER}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri: `http://localhost:${port}`, force: true }),
      });
      if (r.ok) {
        const proc = procs.getState(name);
        proc?.log.push(`[supervisor] registered with Restate admin`);
        return;
      }
    } catch {
      // keep trying
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  procs.getState(name)?.log.push(`[supervisor] failed to register deployment after 30s`);
}

async function awaitListening(port: number, maxMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await procs.isListening(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startAndRegister(name: string): Promise<void> {
  const spec = services.find((s) => s.name === name);
  if (!spec) return;
  await procs.start(name);
  if (spec.port) {
    const ok = await awaitListening(spec.port);
    if (ok && spec.registerDeployment) {
      await registerDeployment(spec.port, name);
    }
  }
}

// Boot order: Restate first (so deployment registrations land somewhere),
// then everything else in parallel — including the BFF, which is just
// another supervised child now that the supervisor is a pure TUI.
async function startAll(): Promise<void> {
  await startAndRegister("restate-server");
  const rest = services.filter((s) => s.name !== "restate-server");
  await Promise.all(rest.map((s) => startAndRegister(s.name)));
}

async function shutdown(): Promise<void> {
  await procs.stopAll();
  // Give children a moment to flush logs / close ports cleanly.
  await new Promise((res) => setTimeout(res, 800));
  process.exit(0);
}

// Kick the boot in the background while the TUI starts immediately — the
// TUI then paints the services as they transition through "starting" →
// "running".
void startAll();

startTui({
  onStart: (name) => { void startAndRegister(name); },
  onStop: (name) => { void procs.stop(name); },
  onRestart: (name) => {
    void (async () => {
      await procs.stop(name);
      await new Promise((r) => setTimeout(r, 1500));
      await startAndRegister(name);
    })();
  },
  onQuit: shutdown,
});

// Safety net in case the TUI isn't started (non-TTY environment).
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
