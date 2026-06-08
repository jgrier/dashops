// Approver UI — polls pending approvals for a selected group; click to approve/reject.
// Quick mock "user identity": pick a name on first load so the approve action
// is attributable in the audit trail.

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
const groupSelect = document.getElementById("group-select");
const toastEl = document.getElementById("toast");

let currentGroup = groupSelect.value;
groupSelect.addEventListener("change", () => {
  currentGroup = groupSelect.value;
  refresh();
});

async function refresh() {
  try {
    const r = await fetch(`/api/approvals/pending?group=${encodeURIComponent(currentGroup)}`);
    if (!r.ok) return;
    const list = await r.json();
    render(Array.isArray(list) ? list : []);
  } catch (e) {
    // ignore
  }
}

function render(list) {
  if (list.length === 0) {
    contentEl.innerHTML = `<div class="empty">No pending approvals for <strong>${escape(
      currentGroup
    )}</strong>.</div>`;
    return;
  }

  contentEl.innerHTML = "";
  list.sort((a, b) => a.createdAtMs - b.createdAtMs);
  for (const item of list) {
    contentEl.appendChild(renderCard(item));
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

refresh();
setInterval(refresh, 1500);
