import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import type { ServiceSpec } from "./config.js";

// Track every spawned child + a rolling log buffer for the UI.

export type ProcStatus = "running" | "stopped" | "starting" | "exited";

export interface ProcState {
  spec: ServiceSpec;
  proc?: ChildProcess;
  pid?: number;
  status: ProcStatus;
  startedAt?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  log: string[];                  // last N lines of combined stdout+stderr
}

const LOG_LINES = 200;
const states = new Map<string, ProcState>();

export function init(specs: ServiceSpec[]): void {
  for (const s of specs) {
    if (!states.has(s.name)) {
      states.set(s.name, { spec: s, status: "stopped", log: [] });
    }
  }
}

export function getState(name: string): ProcState | undefined {
  return states.get(name);
}

export function listStates(): ProcState[] {
  return [...states.values()];
}

// Strip the Restate SDK's standard log boilerplate so the TUI log pane is
// readable. Two transformations:
//   1. Drop the per-invocation chatter ("Starting invocation." +
//      "Invocation completed successfully.") that fires on every single
//      handler call — pure noise at TUI scale.
//   2. Trim "[restate][2026-06-08T...Z][Service/key/handler][inv_xxx] INFO: msg"
//      down to "HH:MM:SS msg". Keep WARN/ERROR levels visible.
// Lines that don't match the Restate format (npm output, our own
// console.logs) pass through unchanged.
const RESTATE_TS_RE = /^\[restate\]\[\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z\]\s*/;
const RESTATE_TAGS_RE = /^(?:\[[^\]]+\])+\s*/;
const SKIP_INVOCATION_NOISE_RE =
  /INFO:\s+(?:Starting invocation|Invocation completed successfully)\.?\s*$/;

function cleanLogLine(line: string): string | null {
  if (line.length === 0) return null;
  if (!line.startsWith("[restate]")) return line;        // npm / app prints, untouched

  if (SKIP_INVOCATION_NOISE_RE.test(line)) return null;  // drop the spammy pair

  const m = line.match(RESTATE_TS_RE);
  if (!m) return line;
  const time = m[1];
  let rest = line.slice(m[0].length).replace(RESTATE_TAGS_RE, "");
  if (rest.startsWith("INFO: ")) rest = rest.slice(6);   // drop the level for INFO; keep WARN/ERROR
  return `${time} ${rest}`.trim();
}

function pushLog(state: ProcState, chunk: Buffer): void {
  const text = chunk.toString("utf-8");
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = cleanLogLine(raw);
    if (line === null) continue;
    state.log.push(line);
    if (state.log.length > LOG_LINES) state.log.shift();
  }
}

export async function start(name: string): Promise<void> {
  const state = states.get(name);
  if (!state) throw new Error(`unknown service: ${name}`);
  if (state.proc && !state.proc.killed) return;     // already running

  state.status = "starting";
  state.log.push(`[supervisor] starting (${new Date().toISOString()})`);

  const env = { ...process.env, ...state.spec.env };
  const proc = spawn(state.spec.command, state.spec.args, {
    cwd: state.spec.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // detached:false so children die with the supervisor
  });

  state.proc = proc;
  state.pid = proc.pid;
  state.startedAt = Date.now();
  state.exitCode = undefined;
  state.exitSignal = undefined;
  state.status = "running";

  proc.stdout?.on("data", (c: Buffer) => pushLog(state, c));
  proc.stderr?.on("data", (c: Buffer) => pushLog(state, c));
  proc.on("exit", (code, signal) => {
    state.exitCode = code;
    state.exitSignal = signal;
    state.proc = undefined;
    state.pid = undefined;
    state.status = "exited";
    state.log.push(
      `[supervisor] exited code=${code} signal=${signal} at ${new Date().toISOString()}`
    );
  });
  proc.on("error", (err) => {
    state.log.push(`[supervisor] spawn error: ${err.message}`);
    state.status = "exited";
    state.proc = undefined;
    state.pid = undefined;
  });
}

export async function stop(name: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const state = states.get(name);
  if (!state || !state.proc) return;
  state.status = "stopped";
  state.log.push(`[supervisor] stopping (${signal})`);
  state.proc.kill(signal);
  // best-effort hard-kill if it lingers
  setTimeout(() => {
    if (state.proc && !state.proc.killed) {
      state.log.push(`[supervisor] forcing SIGKILL`);
      state.proc.kill("SIGKILL");
    }
  }, 3000);
}

export async function restart(name: string): Promise<void> {
  await stop(name);
  // wait briefly for the port to free up
  await new Promise((res) => setTimeout(res, 1500));
  await start(name);
}

export async function stopAll(): Promise<void> {
  for (const s of states.values()) {
    if (s.proc) s.proc.kill("SIGTERM");
  }
}

// Is this port currently accepting connections? Used by the UI to show the
// "listening" pill independent of whether we think the process is running.
export function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port, timeout: 250 });
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => resolve(false));
  });
}
