// Approver UI — polls pending approvals per group, shown as a tab strip
// at the top with live counts. Clicking a tab switches the list below.
// Quick mock "user identity": pick a name on first load so the approve
// action is attributable in the audit trail.

const approverUserId = (() => {
  const k = "dashops_approver_user";
  let u = localStorage.getItem(k);
  if (!u) {
    u = "approver-" + Math.random().toString(36).slice(2, 6);
    localStorage.setItem(k, u);
  }
  return u;
})();

document.getElementById("user-badge").textContent = "user: " + approverUserId;

const contentEl = document.getElementById("content");
const tabsEl = document.getElementById("group-tabs");
const toastEl = document.getElementById("toast");

const GROUPS = ["finance-leads", "ops-managers"];
const GROUP_KEY = "dashops_approver_group";
let currentGroup = GROUPS.includes(localStorage.getItem(GROUP_KEY))
  ? localStorage.getItem(GROUP_KEY)
  : GROUPS[0];

// Per-group pending list cached from the most recent poll. Drives the
// count badge in the tab strip and the cards in the active group view.
const pendingByGroup = new Map(GROUPS.map((g) => [g, []]));

function switchGroup(g) {
  if (currentGroup === g) return;
  currentGroup = g;
  localStorage.setItem(GROUP_KEY, g);
  cardsById.clear();
  contentEl.innerHTML = "";
  renderTabs();
  render(pendingByGroup.get(currentGroup) || []);
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const g of GROUPS) {
    const tab = document.createElement("button");
    tab.className = "group-tab" + (g === currentGroup ? " active" : "");
    const label = document.createElement("span");
    label.textContent = g;
    tab.appendChild(label);
    const count = (pendingByGroup.get(g) || []).length;
    const badge = document.createElement("span");
    badge.className = "count" + (count === 0 ? " zero" : "");
    badge.textContent = count;
    tab.appendChild(badge);
    tab.addEventListener("click", () => switchGroup(g));
    tabsEl.appendChild(tab);
  }
}

async function pollGroup(g) {
  try {
    const r = await fetch(`/api/approvals/pending?group=${encodeURIComponent(g)}`);
    if (!r.ok) return;
    const list = await r.json();
    pendingByGroup.set(g, Array.isArray(list) ? list : []);
  } catch {
    // ignore transient errors
  }
}

async function refresh() {
  await Promise.all(GROUPS.map(pollGroup));
  renderTabs();
  render(pendingByGroup.get(currentGroup) || []);
}

// Map of approvalId -> card element so we can reconcile without nuking
// inputs the user is typing into.
const cardsById = new Map();

function render(list) {
  if (list.length === 0) {
    cardsById.clear();
    contentEl.innerHTML = `<div class="empty">No pending approvals for <strong>${escape(
      currentGroup
    )}</strong>.</div>`;
    return;
  }

  // Drop the empty-state placeholder if present.
  const placeholder = contentEl.querySelector(".empty");
  if (placeholder) {
    contentEl.innerHTML = "";
    cardsById.clear();
  }

  list.sort((a, b) => a.createdAtMs - b.createdAtMs);
  const seen = new Set();

  for (const item of list) {
    seen.add(item.approvalId);
    if (!cardsById.has(item.approvalId)) {
      const card = renderCard(item);
      cardsById.set(item.approvalId, card);
      contentEl.appendChild(card);
    }
  }

  for (const [id, card] of cardsById) {
    if (!seen.has(id)) {
      card.remove();
      cardsById.delete(id);
    }
  }
}

function renderCard(item) {
  const card = document.createElement("div");
  const isAppeal = item.kind === "appeal";
  card.className = "card" + (isAppeal ? " appeal" : "");
  card.innerHTML = `
    <div class="meta">
      ${isAppeal ? '<span class="kind-chip appeal-chip">APPEAL</span>' : ""}
      <span class="tool-chip">${escape(item.toolName)}</span>
      <span>requested by ${escape(item.initiator?.userId ?? "?")} · session ${escape(
    item.initiator?.sessionId ?? "?"
  )}</span>
      <span style="margin-left:auto">${new Date(item.createdAtMs).toLocaleTimeString()}</span>
    </div>
    <div class="summary">${escape(item.actionSummary)}</div>
    <div class="row">
      <input class="input" placeholder="reason (required to reject)" />
      <button class="approve">Approve</button>
      <button class="reject">Reject</button>
    </div>
  `;
  const input = card.querySelector("input");
  card.querySelector("button.approve").addEventListener("click", () =>
    decide(item.approvalId, true, input.value)
  );
  card.querySelector("button.reject").addEventListener("click", () => {
    if (!input.value.trim()) {
      input.focus();
      toast("Provide a reason to reject.");
      return;
    }
    decide(item.approvalId, false, input.value);
  });
  return card;
}

async function decide(approvalId, approved, comment) {
  const r = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved, comment, approverUserId }),
  });
  if (r.ok) {
    toast(approved ? "Approved." : "Rejected.");
    refresh();
  } else {
    toast("Failed: " + (await r.text()));
  }
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1800);
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

renderTabs();
refresh();
setInterval(refresh, 1500);
