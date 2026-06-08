// Vanilla JS for the operator UI. No bundler, no framework.
//
// Multi-session: the user can open many Session VOs at once. Sessions are
// listed as tabs across the top; each tab shows the session's current
// status, and clicking switches the chat below. Closing a tab also resets
// the underlying VO (so we don't accumulate stale state in Restate).
//
// Each Session VO is keyed by sessionId and handles its turns serially —
// see chat with user re: VO lock semantics. Different sessions run
// concurrently because they have different keys.

const SESSIONS_KEY = "dashops_sessions";
const ACTIVE_KEY = "dashops_active_session";
const LEGACY_SINGLE_KEY = "dashops_session_id";

function freshSessionId() {
  return "sess-" + Math.random().toString(36).slice(2, 10);
}

function loadInitialSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
  } catch {}
  // Migrate from the old single-session format if present.
  const legacy = localStorage.getItem(LEGACY_SINGLE_KEY);
  if (legacy) return [legacy];
  return [freshSessionId()];
}

let sessions = loadInitialSessions();
let activeSessionId =
  localStorage.getItem(ACTIVE_KEY) && sessions.includes(localStorage.getItem(ACTIVE_KEY))
    ? localStorage.getItem(ACTIVE_KEY)
    : sessions[0];

function persistSessions() {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  localStorage.setItem(ACTIVE_KEY, activeSessionId);
}
persistSessions();

// Per-session client state. lastState gets refreshed on every poll;
// renderedIds tracks which message ids we've already painted into the DOM
// for that session, so re-rendering on tab-switch reconciles correctly.
const sessionCache = new Map();
function getCache(id) {
  if (!sessionCache.has(id)) {
    sessionCache.set(id, { renderedIds: new Set(), lastState: null });
  }
  return sessionCache.get(id);
}

const messagesEl = document.getElementById("messages");
const tabsEl = document.getElementById("tabs");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const inputEl = document.getElementById("input");
const formEl = document.getElementById("input-form");

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = "";

  // Optimistic render so the UI feels responsive. The poll loop will
  // reconcile against the server echo.
  const optimisticId = "optimistic-" + Date.now();
  getCache(activeSessionId).renderedIds.add(optimisticId);
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

document.getElementById("appeal-btn").addEventListener("click", async () => {
  await fetch(`/api/sessions/${activeSessionId}/appeal`, { method: "POST" });
});

document.querySelectorAll(".seed-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    inputEl.value = chip.dataset.seed;
    inputEl.focus();
  });
});

async function sendMessage(msg) {
  try {
    await fetch(`/api/sessions/${activeSessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: msg }),
    });
  } catch (e) {
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

// ---- session management --------------------------------------------------

function addSession() {
  const id = freshSessionId();
  sessions.push(id);
  switchTo(id);
}

async function closeSession(id) {
  if (sessions.length <= 1) return;        // can't close the last one
  // Wipe the underlying VO so we don't leave orphan state behind. Fire-and-
  // forget; success isn't required for the UI to move on.
  fetch(`/api/sessions/${id}/reset`, { method: "POST" }).catch(() => {});
  sessions = sessions.filter((s) => s !== id);
  sessionCache.delete(id);
  if (activeSessionId === id) {
    activeSessionId = sessions[0];
    switchTo(activeSessionId);
  } else {
    persistSessions();
    renderTabs();
  }
}

function switchTo(id) {
  if (!sessions.includes(id)) return;
  activeSessionId = id;
  persistSessions();
  // Wipe the current DOM and re-paint from the cache (if we have state).
  const cache = getCache(id);
  cache.renderedIds = new Set();
  messagesEl.innerHTML = "";
  if (cache.lastState) {
    renderActive(cache.lastState);
  } else {
    statusEl.className = "status idle";
    statusTextEl.textContent = "idle";
  }
  inputEl.focus();
  renderTabs();
}

// ---- tab rendering -------------------------------------------------------

function statusGlyph(status) {
  // Small character cue per status. Easier to skim across many tabs than
  // a full status word.
  switch (status) {
    case "thinking":
    case "calling_tool":
      return "●";   // working
    case "needs_approval":
    case "appeal_pending":
      return "⏸";   // waiting on human
    case "blocked_appealable":
      return "⚠";
    case "complete":
      return "✓";
    case "failed":
      return "✗";
    default:
      return "·";
  }
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const id of sessions) {
    const cache = getCache(id);
    const status = cache.lastState?.status ?? "idle";
    const tab = document.createElement("button");
    tab.className = "tab" + (id === activeSessionId ? " active" : "") + " s-" + status;
    tab.title = id + " · " + status;

    const glyph = document.createElement("span");
    glyph.className = "tab-glyph";
    glyph.textContent = statusGlyph(status);
    tab.appendChild(glyph);

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = status;
    tab.appendChild(label);

    if (sessions.length > 1) {
      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "close session (also resets the underlying VO)";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeSession(id);
      });
      tab.appendChild(close);
    }

    tab.addEventListener("click", () => switchTo(id));
    tabsEl.appendChild(tab);
  }
  const add = document.createElement("button");
  add.className = "tab tab-add";
  add.textContent = "+";
  add.title = "new session";
  add.addEventListener("click", addSession);
  tabsEl.appendChild(add);
}

// ---- polling -------------------------------------------------------------

async function pollOne(id) {
  try {
    const r = await fetch(`/api/sessions/${id}`);
    if (!r.ok) return;
    const state = await r.json();
    const cache = getCache(id);
    cache.lastState = state;
    if (id === activeSessionId) renderActive(state);
  } catch {
    // ignore transient errors
  }
}

async function pollAll() {
  // Poll every known session in parallel; cheap and keeps tab status pills
  // accurate so you can see at a glance which sessions need attention.
  await Promise.all(sessions.map(pollOne));
  renderTabs();
}

// ---- per-active-session rendering ---------------------------------------

function renderActive(state) {
  // status pill
  statusEl.className = "status " + state.status;
  statusTextEl.textContent = state.status;

  // Disable input whenever the Session VO is mid-turn.
  const busyPlaceholders = {
    thinking: "Agent is thinking…",
    calling_tool: "Agent is calling a tool…",
    needs_approval: "Waiting on approval decision…",
    appeal_pending: "Waiting on appeal decision…",
  };
  const busyHint = busyPlaceholders[state.status];
  const sendBtn = formEl.querySelector("button[type=submit]");
  inputEl.disabled = !!busyHint;
  sendBtn.disabled = !!busyHint;
  if (busyHint) {
    inputEl.dataset.savedPlaceholder ||= inputEl.placeholder;
    inputEl.placeholder = busyHint;
  } else if (inputEl.dataset.savedPlaceholder) {
    inputEl.placeholder = inputEl.dataset.savedPlaceholder;
    delete inputEl.dataset.savedPlaceholder;
  }

  // pending approval banner
  const banner = document.getElementById("pending-banner");
  if (state.pendingApproval) {
    banner.style.display = "block";
    document.getElementById("pending-group").textContent = state.pendingApproval.approverGroup;
    document.getElementById("pending-summary").textContent = state.pendingApproval.actionSummary;
  } else {
    banner.style.display = "none";
  }

  // appeal banner
  const appealBanner = document.getElementById("appeal-banner");
  if (state.status === "blocked_appealable" && state.pendingAppeal) {
    appealBanner.style.display = "block";
    document.getElementById("appeal-source").textContent = state.pendingAppeal.blockSource;
    document.getElementById("appeal-reason").textContent = state.pendingAppeal.blockReason;
    document.getElementById("appeal-group").textContent = state.pendingAppeal.approverGroup;
  } else {
    appealBanner.style.display = "none";
  }

  // messages — append new ones only. Reconcile optimistic renders against
  // the server-side echo by content match.
  const cache = getCache(activeSessionId);
  const wasNearBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  let appended = false;
  const serverMessages = state.messages || [];
  for (const m of serverMessages) {
    if (cache.renderedIds.has(m.id)) continue;
    if (m.role === "user") {
      const optimisticNodes = messagesEl.querySelectorAll(".msg.user");
      for (const node of optimisticNodes) {
        if (node.dataset.optimistic === "1" && node.dataset.content === m.content) {
          node.remove();
        }
      }
    }
    cache.renderedIds.add(m.id);
    messagesEl.appendChild(renderMessage(m));
    appended = true;
  }
  if (appended && wasNearBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
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

  if (m.role === "tool" && m.toolResult !== undefined) {
    const det = document.createElement("details");
    det.className = "tool-collapse";
    const sum = document.createElement("summary");
    sum.appendChild(roleLine);
    const c = document.createElement("span");
    c.className = "content-preview";
    c.textContent = m.content;
    sum.appendChild(c);
    det.appendChild(sum);
    const r = document.createElement("pre");
    r.className = "tool-result";
    r.textContent = JSON.stringify(m.toolResult, null, 2);
    det.appendChild(r);
    div.appendChild(det);
    return div;
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

renderTabs();
pollAll();
setInterval(pollAll, 800);
