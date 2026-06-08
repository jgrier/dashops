// Terminal UI for the DashOps supervisor. Dependency-free; raw ANSI
// escapes + stdin raw mode. Repaints on a timer and on keystrokes.
//
// Layout: one row per supervised service with status pill, PID, uptime,
// port. Arrow keys move the selection. Letters drive actions on the
// selected row. The bottom of the screen is the log pane for whichever
// process is selected — toggle it with `l`.

import * as procs from "./procs.js";

const ESC = "\x1b[";
const CLEAR_SCREEN = ESC + "2J" + ESC + "H";
const HIDE_CURSOR = ESC + "?25l";
const SHOW_CURSOR = ESC + "?25h";
const RESET = ESC + "0m";
const BOLD = ESC + "1m";
const DIM = ESC + "2m";
const GREEN = ESC + "32m";
const RED = ESC + "31m";
const YELLOW = ESC + "33m";
const MUTED = ESC + "90m";
const ACCENT = ESC + "38;5;208m";  // 256-color orange to match the web theme

interface RunOptions {
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onRestart: (name: string) => void;
  onQuit: () => Promise<void>;
}

let selected = 0;
let logOpen = true;
let timer: NodeJS.Timeout | null = null;
let opts: RunOptions | null = null;

function fmtUptime(startedAt?: number): string {
  if (!startedAt) return "";
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60).toString().padStart(2, "0") + "s";
  return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function statusPill(status: procs.ProcStatus): string {
  switch (status) {
    case "running":  return GREEN  + "● RUNNING " + RESET;
    case "starting": return YELLOW + "○ STARTING" + RESET;
    case "stopped":  return MUTED  + "· STOPPED " + RESET;
    case "exited":   return RED    + "✗ EXITED  " + RESET;
    default:         return DIM    + status + RESET;
  }
}

function render(): void {
  const states = procs.listStates();
  if (selected >= states.length) selected = Math.max(0, states.length - 1);

  let out = CLEAR_SCREEN;
  out += BOLD + ACCENT + "DashOps Supervisor" + RESET +
    MUTED + "   pid " + process.pid + "   " + states.length + " supervised processes" + RESET +
    "\n\n";

  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    const arrow = i === selected ? ACCENT + " ▶ " + RESET : "   ";
    const name = pad(s.spec.name, 18);
    const pill = statusPill(s.status);
    const pid = s.pid ? MUTED + "pid " + pad(String(s.pid), 6) + RESET : MUTED + "             " + RESET;
    const uptime = s.startedAt && s.status === "running"
      ? MUTED + "up " + pad(fmtUptime(s.startedAt), 8) + RESET
      : MUTED + "            " + RESET;
    const port = s.spec.port ? MUTED + ":" + s.spec.port + RESET : "";
    out += arrow + name + "  " + pill + "  " + pid + " " + uptime + " " + port + "\n";
  }

  out += "\n";
  out += MUTED + "  [↑/↓] move    [s] start    [k] kill    [r] restart    [l] " +
    (logOpen ? "hide" : "show") + " log    [q] quit (kills everything)" + RESET + "\n";

  if (logOpen && states.length > 0) {
    const s = states[selected];
    const title = "  ── log: " + s.spec.name + " ";
    out += "\n" + MUTED + title + "─".repeat(Math.max(0, 80 - title.length)) + RESET + "\n";
    const lines = s.log.slice(-12);
    if (lines.length === 0) {
      out += DIM + "    (no output yet)" + RESET + "\n";
    } else {
      for (const line of lines) {
        // Truncate so terminal wrapping doesn't break the layout
        const trimmed = line.length > 110 ? line.slice(0, 107) + "..." : line;
        out += "    " + MUTED + trimmed + RESET + "\n";
      }
    }
  }

  process.stdout.write(out);
}

async function handleKey(key: string): Promise<void> {
  if (!opts) return;
  const states = procs.listStates();
  const cur = states[selected];

  // Quit on Ctrl-C, Ctrl-D, or q
  if (key === "\x03" || key === "\x04" || key === "q" || key === "Q") {
    await teardown();
    await opts.onQuit();
    return;
  }

  switch (key) {
    case "\x1b[A": // up
      selected = Math.max(0, selected - 1);
      break;
    case "\x1b[B": // down
      selected = Math.min(states.length - 1, selected + 1);
      break;
    case "s":
      if (cur) opts.onStart(cur.spec.name);
      break;
    case "k":
      if (cur) opts.onStop(cur.spec.name);
      break;
    case "r":
      if (cur) opts.onRestart(cur.spec.name);
      break;
    case "l":
    case "L":
      logOpen = !logOpen;
      break;
  }
  render();
}

async function teardown(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  process.stdout.write(SHOW_CURSOR + RESET + "\n");
}

export function startTui(o: RunOptions): void {
  opts = o;
  if (!process.stdin.isTTY) {
    console.error("supervisor: stdin is not a TTY — refusing to start the TUI.");
    console.error("Run from an interactive terminal (e.g. `npm run dev:supervisor`).");
    return;
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write(HIDE_CURSOR);

  process.stdin.on("data", (chunk: string) => {
    void handleKey(chunk);
  });

  timer = setInterval(render, 500);
  render();
}
