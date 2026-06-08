import * as http from "node:http";

export interface OpsViewSection {
  title: string;
  // Each section renders a small HTML fragment. Async because some services
  // (e.g. gateway) fetch live data from Restate to build the table.
  render: () => string | Promise<string>;
}

export interface OpsViewOptions {
  port: number;
  serviceName: string;
  role: string;                  // one-line description shown under the title
  // Sections render in order. Each is wrapped in a card.
  sections: OpsViewSection[];
}

// Spawns a tiny HTTP server that serves a single status page for the
// owning service. Convention: services run on PORT, their ops view runs
// on PORT + 100. The page is fully server-rendered on each request, so
// counters/live data update by browser refresh — no client-side polling
// needed for the demo.
export function serveOpsView(opts: OpsViewOptions): void {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/" || req.url === "/index.html") {
        const sectionHtml: string[] = [];
        for (const s of opts.sections) {
          const inner = await s.render();
          sectionHtml.push(
            `<div class="card"><h2>${escapeHtml(s.title)}</h2>${inner}</div>`
          );
        }
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(renderPage(opts.serviceName, opts.role, sectionHtml.join("\n")));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    } catch (e) {
      res.statusCode = 500;
      res.end(`error: ${(e as Error).message}`);
    }
  });
  server.listen(opts.port, () => {
    console.log(`  ops view: http://localhost:${opts.port}`);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(serviceName: string, role: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(serviceName)} · ops view</title>
<meta http-equiv="refresh" content="3" />
<style>
:root {
  --bg: #1a1a1a; --surface: #242424; --border: #333;
  --text: #e0e0e0; --muted: #888; --accent: #f55b35; --chip: #2a3a4a; --chip-fg: #88c0d0;
}
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg); color: var(--text); margin: 0; padding: 0; }
.topnav { background: #0e0e0e; padding: 10px 24px; border-bottom: 1px solid var(--border);
  display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
.topnav nav { display: flex; gap: 14px; }
.topnav a { color: var(--muted); text-decoration: none; }
.topnav a:hover { color: var(--accent); }
.container { max-width: 880px; margin: 0 auto; padding: 24px; }
h1 { color: var(--accent); margin: 0 0 4px 0; font-size: 24px; }
.role { color: var(--muted); font-size: 14px; margin-bottom: 24px; }
h2 { margin: 0 0 12px 0; font-size: 14px; text-transform: uppercase;
  letter-spacing: 1px; color: var(--muted); font-weight: 600; }
.card { background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 8px 14px 8px 0; text-align: left; font-size: 13px; }
th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
td { border-bottom: 1px solid #2a2a2a; }
.chip { background: var(--chip); color: var(--chip-fg); font-size: 11px;
  padding: 2px 8px; border-radius: 3px; font-family: ui-monospace, monospace; }
.counter { font-family: ui-monospace, monospace; color: var(--chip-fg); font-weight: 600; }
.muted { color: var(--muted); }
.empty { color: var(--muted); font-style: italic; font-size: 13px; }
code { font-family: ui-monospace, monospace; font-size: 12px; color: var(--chip-fg); }
</style>
</head>
<body>
<div class="topnav">
  <nav>
    <a href="http://localhost:3000/operator">operator</a>
    <a href="http://localhost:3000/approver">approver</a>
    <a href="http://localhost:3000/services">services</a>
  </nav>
  <span class="muted">auto-refresh: 3s</span>
</div>
<div class="container">
  <h1>${escapeHtml(serviceName)}</h1>
  <div class="role">${escapeHtml(role)}</div>
  ${body}
</div>
</body>
</html>`;
}
