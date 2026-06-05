// Vanilla JS for the operator UI. No bundler, no framework.
// Polls the session state at ~300ms while a turn is in flight.

const sessionId = (() => {
  const k = "dashops_session_id";
  let s = localStorage.getItem(k);
  if (!s) {
    s = "sess-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(k, s);
  }
  return s;
})();

document.getElementById("session-id-badge").textContent = "session: " + sessionId;

const messagesEl = document.getElementById("messages");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const inputEl = document.getElementById("input");
const formEl = document.getElementById("input-form");

let lastMessageCount = 0;
let pollHandle = null;
let renderedMessageIds = new Set();

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = "";
  sendMessage(msg);
});

document.querySelectorAll(".seed-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    inputEl.value = chip.dataset.seed;
    inputEl.focus();
  });
});

async function sendMessage(msg) {
  await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: msg }),
  });
  startPolling();
}

function startPolling() {
  if (pollHandle) return;
  pollHandle = setInterval(pollOnce, 300);
}

function stopPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

async function pollOnce() {
  try {
    const r = await fetch(`/api/sessions/${sessionId}`);
    if (!r.ok) return;
    const state = await r.json();
    render(state);
    if (state.status === "complete" || state.status === "failed") {
      stopPolling();
    }
  } catch (e) {
    // ignore transient errors
  }
}

function render(state) {
  // status
  statusEl.className = "status " + state.status;
  statusTextEl.textContent = state.status;

  // messages — append new ones only
  for (const m of state.messages || []) {
    if (renderedMessageIds.has(m.id)) continue;
    renderedMessageIds.add(m.id);
    messagesEl.appendChild(renderMessage(m));
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(m) {
  const div = document.createElement("div");
  div.className = "msg " + m.role;
  const roleLine = document.createElement("div");
  roleLine.className = "role";
  let roleText = m.role;
  if (m.role === "tool" && m.toolName) roleText = "tool · " + m.toolName;
  roleLine.textContent = roleText;
  if (typeof m.costCents === "number" && m.costCents > 0) {
    const cost = document.createElement("span");
    cost.className = "cost";
    cost.textContent = "cost: " + (m.costCents / 100).toFixed(2) + "¢";
    roleLine.appendChild(cost);
  }
  div.appendChild(roleLine);

  const content = document.createElement("div");
  content.textContent = m.content;
  div.appendChild(content);

  if (m.toolResult !== undefined) {
    const r = document.createElement("pre");
    r.className = "tool-result";
    r.textContent = JSON.stringify(m.toolResult, null, 2);
    div.appendChild(r);
  }
  return div;
}

// On load, render whatever is in the session already.
pollOnce();
