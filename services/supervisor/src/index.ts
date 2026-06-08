import http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { services } from "./config.js";
import * as procs from "./procs.js";
import { handleBff } from "./bff.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..", "..");
const WEB_ROOT = path.resolve(ROOT, "web");

// Make sure each spec is resolved to an absolute cwd before spawning.
for (const s of services) {
  if (s.cwd) s.cwd = path.resolve(ROOT, s.cwd);
}

procs.init(services);

const PORT = parseInt(process.env.SUPERVISOR_PORT ?? "3001", 10);
const ADMIN_UI = process.env.RESTATE_ADMIN_UI ?? "http://localhost:9070";
const ADMIN_REGISTER = process.env.RESTATE_ADMIN ?? "http://localhost:9070";

// After Restate is healthy and a service is listening, post its endpoint to
// Restate's /deployments. Replaces register.sh.
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
  const proc = procs.getState(name);
  proc?.log.push(`[supervisor] failed to register deployment after 30s`);
}

// Wait for a port to start accepting connections, then trigger the
// per-service post-start work.
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

// Bring everything up in order: Restate first (so registrations land), then
// the rest in parallel.
async function startAll(): Promise<void> {
  console.log("== supervisor: bringing up restate-server first ==");
  await startAndRegister("restate-server");
  console.log("== supervisor: bringing up application services ==");
  const rest = services.filter((s) => s.name !== "restate-server");
  await Promise.all(rest.map((s) => startAndRegister(s.name)));
  console.log("== supervisor: all started ==");
}

// ---------------- HTTP server / UI ----------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;

  // ---- BFF (stateless): chat UIs + Restate proxies + services portal ----
  // Try this first. Any browser-facing or app-data route is here, and the
  // handler does no in-process state lookups on the supervisor side.
  if (await handleBff(req, res, WEB_ROOT)) return;

  // ---- Control plane (stateful): process management API ----

  // GET /api/state — snapshot of every supervised service
  if (p === "/api/state" && req.method === "GET") {
    const states = await Promise.all(
      procs.listStates().map(async (s) => ({
        name: s.spec.name,
        role: s.spec.role,
        cwd: s.spec.cwd,
        port: s.spec.port,
        pid: s.pid,
        status: s.status,
        startedAt: s.startedAt,
        exitCode: s.exitCode,
        exitSignal: s.exitSignal,
        listening: s.spec.port ? await procs.isListening(s.spec.port) : null,
        logTail: s.log.slice(-8),
      }))
    );
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(states));
    return;
  }

  // GET /api/services/:name/log
  const logMatch = p.match(/^\/api\/services\/([^/]+)\/log$/);
  if (logMatch && req.method === "GET") {
    const s = procs.getState(decodeURIComponent(logMatch[1]));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ log: s?.log ?? [] }));
    return;
  }

  // POST /api/services/:name/(start|stop|restart)
  const actMatch = p.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/);
  if (actMatch && req.method === "POST") {
    const name = decodeURIComponent(actMatch[1]);
    const action = actMatch[2];
    if (action === "start") {
      void startAndRegister(name);
    } else if (action === "stop") {
      void procs.stop(name);
    } else {
      void (async () => {
        await procs.stop(name);
        await new Promise((r) => setTimeout(r, 1500));
        await startAndRegister(name);
      })();
    }
    res.statusCode = 202;
    res.end("{}");
    return;
  }

  // GET /supervisor — control panel
  if (p === "/supervisor" || p === "/supervisor/") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(renderUi());
    return;
  }

  res.statusCode = 404;
  res.end("not found");
}

function renderUi(): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>DashOps · supervisor</title>
<style>
:root {
  --bg: #0e1116; --surface: #161b22; --surface-2: #1f262e;
  --border: #2a3038; --fg: #e6edf3; --fg-muted: #9ba6b3;
  --accent: #f55b35; --ok: #4dd478; --warn: #ffcc4d; --bad: #f55b35;
}
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg); color: var(--fg); margin: 0; }
.topnav {
  background: #0e0e0e; padding: 10px 24px; border-bottom: 1px solid #2a3038;
  display: flex; align-items: center; gap: 16px; font-size: 13px;
}
.topnav a { color: #9ba6b3; text-decoration: none; }
.topnav a:hover { color: #f55b35; }
.topnav a.active { color: #f55b35; font-weight: 600; }
.container { max-width: 1100px; margin: 0 auto; padding: 24px; }
h1 { color: var(--accent); margin: 0 0 4px 0; font-size: 22px; }
.subtitle { color: var(--fg-muted); font-size: 13px; margin-bottom: 20px; }
table { width: 100%; border-collapse: collapse; background: var(--surface);
  border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
th, td { padding: 10px 14px; text-align: left; font-size: 13px;
  border-bottom: 1px solid var(--border); }
th { color: var(--fg-muted); font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.5px; background: var(--surface-2); }
tr:last-child td { border-bottom: 0; }
.pill { display: inline-block; padding: 2px 8px; font-size: 11px;
  border-radius: 3px; font-family: ui-monospace, monospace; font-weight: 600; }
.pill.running    { background: #1f3a1f; color: var(--ok); }
.pill.exited     { background: #3a1f1f; color: var(--bad); }
.pill.stopped    { background: #2a2a2a; color: var(--fg-muted); }
.pill.starting   { background: #3a2a05; color: var(--warn); }
.pill.listening  { background: #1f3a1f; color: var(--ok); margin-left: 4px; }
.pill.not-listen { background: #2a2a2a; color: var(--fg-muted); margin-left: 4px; }
.actions button {
  background: var(--surface-2); color: var(--fg); border: 1px solid var(--border);
  border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer; margin-right: 4px;
}
.actions button:hover { border-color: var(--accent); color: var(--accent); }
.actions button.kill:hover { color: #f55b35; border-color: #f55b35; }
.actions button.restart:hover { color: #ffcc4d; border-color: #ffcc4d; }
code { font-family: ui-monospace, monospace; font-size: 12px; color: #88c0d0; }
.role { color: var(--fg-muted); font-size: 12px; }
.row-log {
  font-family: ui-monospace, monospace; font-size: 11px;
  color: var(--fg-muted); background: #0a0d12; padding: 8px 14px;
  white-space: pre-wrap; word-break: break-word; max-height: 160px;
  overflow-y: auto; display: none;
}
.row-log.open { display: block; }
.toggle-log {
  background: none; border: none; color: var(--fg-muted); cursor: pointer;
  font-size: 11px; padding: 0; text-decoration: underline dotted;
}
.uptime { color: var(--fg-muted); font-size: 11px; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<div class="topnav">
  <a href="/operator">operator</a>
  <a href="/approver">approver</a>
  <a href="/services">services</a>
  <a href="/supervisor" class="active">supervisor</a>
</div>
<div class="container">
  <h1>Supervisor</h1>
  <div class="subtitle">
    Master process. Each row is a child the supervisor spawned. Stop / restart
    any of them to inject failure — watch the rest keep going (or fail in
    interesting ways). Killing <code>restate-server</code> is the strongest
    test: every other service loses its backing, and journals replay on
    restart.
  </div>
  <table id="tbl">
    <thead>
      <tr>
        <th>service</th>
        <th>status</th>
        <th>pid</th>
        <th>uptime</th>
        <th>port</th>
        <th>ops view</th>
        <th>actions</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<script>
function fmtUptime(startedAt) {
  if (!startedAt) return "";
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60) + "s";
  return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
}
function statusPill(st) {
  return '<span class="pill ' + st + '">' + st + '</span>';
}
function listenPill(state) {
  if (state.listening === null) return "";
  return state.listening
    ? '<span class="pill listening">listening</span>'
    : '<span class="pill not-listen">not listening</span>';
}
function rowKey(name) { return "row-" + name; }
function logKey(name) { return "log-" + name; }

async function poll() {
  const r = await fetch("/api/state");
  if (!r.ok) return;
  const list = await r.json();
  const tbody = document.getElementById("tbody");
  // Build by upserting rows so the open-log state is preserved.
  for (const s of list) {
    let row = document.getElementById(rowKey(s.name));
    if (!row) {
      row = document.createElement("tr");
      row.id = rowKey(s.name);
      tbody.appendChild(row);
      const logRow = document.createElement("tr");
      logRow.id = "logrow-" + s.name;
      const logTd = document.createElement("td");
      logTd.colSpan = 7;
      logTd.style.padding = 0;
      const pre = document.createElement("pre");
      pre.className = "row-log";
      pre.id = logKey(s.name);
      logTd.appendChild(pre);
      logRow.appendChild(logTd);
      tbody.appendChild(logRow);
    }
    row.innerHTML =
      '<td><strong>' + s.name + '</strong>' +
        '<div class="role">' + (s.role ?? "") + '</div></td>' +
      '<td>' + statusPill(s.status) + listenPill(s) + '</td>' +
      '<td><code>' + (s.pid ?? "—") + '</code></td>' +
      '<td><span class="uptime">' + (s.startedAt ? fmtUptime(s.startedAt) : "") + '</span></td>' +
      '<td>' + (s.port ? '<code>:' + s.port + '</code>' : "") + '</td>' +
      '<td>' + (s.name !== "restate-server" ? '<a href="/ops/' + s.name + '">view ↗</a>' : "") + '</td>' +
      '<td class="actions">' +
        '<button onclick="act(\\''+s.name+'\\',\\'start\\')">start</button>' +
        '<button class="restart" onclick="act(\\''+s.name+'\\',\\'restart\\')">restart</button>' +
        '<button class="kill" onclick="act(\\''+s.name+'\\',\\'stop\\')">stop</button>' +
        '<button class="toggle-log" onclick="toggleLog(\\''+s.name+'\\')">log</button>' +
      '</td>';
    const pre = document.getElementById(logKey(s.name));
    if (pre && pre.classList.contains("open")) {
      pre.textContent = (s.logTail ?? []).join("\\n");
    }
  }
}
async function act(name, action) {
  await fetch("/api/services/" + encodeURIComponent(name) + "/" + action, { method: "POST" });
}
async function toggleLog(name) {
  const pre = document.getElementById(logKey(name));
  pre.classList.toggle("open");
  if (pre.classList.contains("open")) {
    const r = await fetch("/api/services/" + encodeURIComponent(name) + "/log");
    if (r.ok) {
      const { log } = await r.json();
      pre.textContent = log.join("\\n");
      pre.scrollTop = pre.scrollHeight;
    }
  }
}
poll();
setInterval(poll, 1500);
</script>
</body></html>`;
}

server.listen(PORT, () => {
  console.log(`Supervisor listening on http://localhost:${PORT}`);
  console.log(`  control panel: http://localhost:${PORT}/`);
  console.log(`  Restate admin: ${ADMIN_UI}/ui/`);
  // Kick off the boot sequence.
  void startAll();
});

// On Ctrl-C / kill, take all children down with us.
async function shutdown(signal: string) {
  console.log(`\nsupervisor: received ${signal}, stopping children…`);
  await procs.stopAll();
  // Give children a moment to flush logs
  setTimeout(() => process.exit(0), 800);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
