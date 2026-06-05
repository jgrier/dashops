// Vanilla JS for the operator UI. No bundler, no framework.

const SESSION_KEY = "dashops_session_id";

function freshSessionId() {
  return "sess-" + Math.random().toString(36).slice(2, 10);
}

function loadOrCreateSessionId() {
  let s = localStorage.getItem(SESSION_KEY);
  if (!s) {
    s = freshSessionId();
    localStorage.setItem(SESSION_KEY, s);
  }
  return s;
}

let sessionId = loadOrCreateSessionId();

document.getElementById("session-id-badge").textContent = "session: " + sessionId;

const messagesEl = document.getElementById("messages");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const inputEl = document.getElementById("input");
const formEl = document.getElementById("input-form");
const newSessionBtn = document.getElementById("new-session-btn");

let renderedMessageIds = new Set();

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = "";

  // Render the user's message IMMEDIATELY so the UI feels responsive.
  // The polling loop will reconcile when the real one comes back.
  const optimisticId = "optimistic-" + Date.now();
  renderedMessageIds.add(optimisticId);
  messagesEl.appendChild(
    renderMessage({
      id: optimisticId,
      role: "user",
      content: msg,
      timestampMs: Date.now(),
    })
  );
  messagesEl.scrollTop = messagesEl.scrollHeight;

  sendMessage(msg);
});

newSessionBtn.addEventListener("click", async () => {
  // Reset the server side (clears VO state); generate a fresh session_id
  // locally; rewipe the UI.
  try {
    await fetch(`/api/sessions/${sessionId}/reset`, { method: "POST" });
  } catch {}
  sessionId = freshSessionId();
  localStorage.setItem(SESSION_KEY, sessionId);
  document.getElementById("session-id-badge").textContent = "session: " + sessionId;
  renderedMessageIds = new Set();
  messagesEl.innerHTML = "";
  document.getElementById("pending-banner").style.display = "none";
  statusEl.className = "status idle";
  statusTextEl.textContent = "idle";
  inputEl.focus();
});

document.querySelectorAll(".seed-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    inputEl.value = chip.dataset.seed;
    inputEl.focus();
  });
});

async function sendMessage(msg) {
  try {
    await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: msg }),
    });
  } catch (e) {
    // surface a system-style note if the bridge is down
    messagesEl.appendChild(
      renderMessage({
        id: "err-" + Date.now(),
        role: "system",
        content: "Failed to send: " + (e && e.message ? e.message : String(e)),
        timestampMs: Date.now(),
      })
    );
  }
}

async function pollOnce() {
  try {
    const r = await fetch(`/api/sessions/${sessionId}`);
    if (!r.ok) return;
    const state = await r.json();
    render(state);
  } catch (e) {
    // ignore transient errors
  }
}

function render(state) {
  // status
  statusEl.className = "status " + state.status;
  statusTextEl.textContent = state.status;

  // pending approval banner
  const banner = document.getElementById("pending-banner");
  if (state.pendingApproval) {
    banner.style.display = "block";
    document.getElementById("pending-group").textContent = state.pendingApproval.approverGroup;
    document.getElementById("pending-summary").textContent = state.pendingApproval.actionSummary;
  } else {
    banner.style.display = "none";
  }

  // messages — append new ones only. Reconcile optimistic renders by
  // matching the latest user message: if our server-side echo arrives
  // and we still have an optimistic version of the same content, drop
  // the optimistic one so we don't double-render.
  const serverMessages = state.messages || [];
  for (const m of serverMessages) {
    if (renderedMessageIds.has(m.id)) continue;
    if (m.role === "user") {
      // remove any optimistic user message with matching content
      const optimisticNodes = messagesEl.querySelectorAll(".msg.user");
      for (const node of optimisticNodes) {
        if (
          node.dataset.optimistic === "1" &&
          node.dataset.content === m.content
        ) {
          node.remove();
        }
      }
    }
    renderedMessageIds.add(m.id);
    messagesEl.appendChild(renderMessage(m));
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(m) {
  const div = document.createElement("div");
  div.className = "msg " + m.role;
  if (m.id && m.id.startsWith("optimistic-")) {
    div.dataset.optimistic = "1";
    div.dataset.content = m.content;
  }
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

pollOnce();
setInterval(pollOnce, 800);
