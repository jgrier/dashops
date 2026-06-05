# DashOps Demo — Walkthrough

This is the morning hand-off. The full demo arc from the spec works end-to-end. What's below: how to run it, what each scene shows, what changed overnight from the design we locked in, and what's deferred.

---

## TL;DR — what works

All five demo scenes are functional and verified:

1. **Insight mode** — operator asks "what happened with delivery #12345?", agent runs a multi-step investigation, journals every step in the Restate UI.
2. **PII guardrail** — gateway-side LLM-style middleware blocks calls whose params contain PII patterns.
3. **Async HITL approval** — agent suspends on an awakeable for hours/days; resumes on approver click; **kill the ops-agent process mid-suspension and approval still completes the agent on restart.**
4. **Hierarchical token-bucket rate limits** — 7 calls against a 6/min tool: first six instant, 7th durably suspended on `ctx.sleep` (the answer to Vasily's "who handles retry when overloaded" question).
5. **Failure / patch / replay** — buggy `apply_credit` retries 3x, pauses; restart tool with patched code; `PATCH /invocations/{id}/resume`; replay continues from the failure point on the new code.

---

## Quick start

```bash
# from /Users/jgrier/src/jgrier/food-delivery
bash scripts/start-all.sh
```

This brings up `restate-server` (native binary) + all five Node services + registers everything. Then:

- **Operator UI**: <http://localhost:3000/operator>
- **Approver UI**: <http://localhost:3000/approver>
- **Restate admin UI**: <http://localhost:9070>

Shut it all down:

```bash
bash scripts/stop-all.sh
```

---

## Architecture (what got built)

```
              ┌─────────────┐                        ┌─────────────┐
              │ Operator UI │                        │ Approver UI │
              │   :3000     │                        │   :3000     │
              │ /operator   │                        │ /approver   │
              └──────┬──────┘                        └──────┬──────┘
                     │ POST /api/sessions/X/messages       │ POST /api/approvals/X/respond
                     │ GET  /api/sessions/X                │ GET  /api/approvals/pending?group=...
                     ▼                                      ▼
                ┌─────────────────────────────────────────────────┐
                │             Ops-agent web bridge                │
                │       (HTTP/SSE proxy → Restate ingress)        │
                └────────────────────┬────────────────────────────┘
                                     │ Restate ingress :8080
                                     ▼
                     ┌────────────────────────────────────┐
                     │           Restate runtime          │
                     │ (8080 ingress · 9070 admin/UI)     │
                     └─┬───────┬──────┬───────┬──────┬────┘
                       │       │      │       │      │
                       ▼       ▼      ▼       ▼      ▼
                   Session  Gateway  Tools  Guard-  Approval-
                   (TS)     (TS)     (TS)   rails   service
                                            (TS)    (TS)

  Session VO              keyed by session_id     — operator chat state, reagent loop
  Gateway service         single endpoint         — registry lookup → guardrail → policy
                                                    → token bucket → identity → dispatch → cost
  ToolRegistry VO         keyed by "default"      — dynamic tool registration
  CostLedger VO           keyed by tenant_id      — per-tenant cost ledger
  TokenBucket VO          keyed by resource       — hierarchical rate limits
  Tools (Restate services): DeliveryLookup, CustomerLookup, EscalationHistory,
                           SemanticSearch, ApplyCredit, CustomerOutreach,
                           MerchantStatus
  PIIGuardrail service    — regex pre-screen; LLM upgrade ready (see "deferred")
  ApprovalService VO      keyed by approval_id    — awakeable handle, audit
  PendingApprovalsIndex VO keyed by approver_grp  — UI poll source
```

Everything runs in TypeScript. Single language, single repo, npm workspaces.

---

## Demo scenes — exact steps

### Setup

Before walking through, make sure the system is up and clean. The seed chips in the operator UI are pre-populated for these scenarios.

### Scene 1 — Insight mode + durable mesh (2 min)

**Operator UI** → click chip *"What happened with delivery #12345?"* → Send.

You should see, streamed live:

1. `[assistant] Let me start by pulling up delivery #12345.`
2. `[tool · delivery_lookup]` → delivery JSON with issues
3. `[assistant] Checking the escalation history for this delivery.`
4. `[tool · escalation_history]` → 3 escalations, last satisfaction 1/5
5. `[assistant] Looking up the customer's profile…`
6. `[tool · customer_lookup]` → Aiyana Patel, gold tier
7. `[assistant] I have what I need. Putting the summary together.`
8. `[assistant]` final markdown report

**Pivot to Restate UI** (<http://localhost:9070>) → Invocations tab → click into the `Session/X/sendMessage` invocation → see the journal: every tool call, every state mutation, all linked.

Talking points:
- *Every hop is durable. Every call is in the journal. We didn't write any retry or persistence code — it's all the substrate.*

### Scene 2 — Guardrail middleware (1 min)

**Operator UI** → chip *"Find complaints (PII)"* — this issues a search containing `555-867-5309` as a phone number.

You should see:

1. `[assistant] Let me search for similar past complaints.`
2. `[system] Gateway blocked the call to semantic_search: Detected possible PII in tool params: phone (555-867-5309)`

The session ends in `failed` state with the PII reason as `failureReason`.

Talking points:
- *The gateway's a cross-cutting middleware point. The guardrail is just another Restate service in the pipeline — durable like everything else.*

### Scene 3 — Async HITL approval (4 min — the centerpiece)

**Operator UI** → chip *"Apologize + $20 credit (delivery #12345)"* → Send.

You see investigation steps as in Scene 1, then:

- `[assistant] Applying a $20.00 credit to Aiyana Patel given the unresolved escalation.`
- `[system] Waiting on approval from finance-leads: Apply $20.00 credit…`
- Pending-approval banner appears across the top of the operator UI.

**Open the Approver UI** in another window. Group dropdown → `finance-leads`. A card appears with the pending approval. Type a reason if you want, click **Approve**.

Watch the operator UI: `[system] Approved by approver-xxxx. Proceeding with apply_credit.` → `[tool · apply_credit]` → next step.

Then a second approval lands for the outreach (`ops-managers` group). Switch the approver dropdown to `ops-managers`. Click **Approve**. Operator UI completes: *"Action complete for delivery #12345. Credited $20.00 to Aiyana Patel… Sent apology_with_credit…"*

**The killer beat (rehearse before doing live):**

While the agent is in `needs_approval` state:

```bash
# kill ONLY the ops-agent listener (filter is critical — see "lessons learned" below)
kill $(lsof -nP -iTCP:9083 -sTCP:LISTEN -ti) $(lsof -nP -iTCP:3000 -sTCP:LISTEN -ti)
```

The ops-agent process is gone. Wait 10 seconds (in the narration: hours or days). Now restart it:

```bash
cd services/ops-agent && npm run dev &
```

The session state is still readable (Restate is the source of truth). Click **Approve** in the approver UI. Watch the agent resume on the brand-new process — same conversation, same session_id, no work redone.

Talking points:
- *That suspended invocation held zero compute. No timer, no thread. Just durable state in Restate. It could have been suspended for a week.*
- *And it resumed on a process that didn't exist when it started.*

### Scene 4 — Rate limit / "who handles retry" (1.5 min)

**Operator UI** → chip *"Merchant batch (rate-limit)"*. This fires 7 `merchant_status` calls. The tool is registered at 6/min in the registry.

You'll see the first 6 tool entries appear almost instantly. The 7th sits — the agent's status stays at `calling_tool`. After ~10 seconds, the 7th completes. Total session time ≈ 11s.

**Pivot to Restate UI** during the wait → invocations list → the `Gateway/callTool` invocation is in a `Suspended` state, waiting on a `ctx.sleep`.

Talking points:
- *The agent is NOT retrying. There's no client-side backoff loop. The gateway's handler is durably suspended on `ctx.sleep`. Same code works for 7 calls or 7 million.*
- *In Restate 1.8 (next quarter), vqueues will give you richer N-concurrent-per-key with budget tracking. Today, per-key serialization + token-bucket VOs already cover what most rate-limit needs look like.*

### Scene 5 — Failure, patch, replay (3 min — Stephan's moment)

**Pre-stage**: tools service must be running with `BUGGY_MODE=1`.

```bash
bash scripts/stop-all.sh
BUGGY_MODE=1 bash scripts/start-all.sh   # note: TOOLS_ENV passed through
```

Actually simpler — restart just tools with the env var:

```bash
kill $(lsof -nP -iTCP:9082 -sTCP:LISTEN -ti)
( cd services/tools && BUGGY_MODE=1 npm run dev > /tmp/dashops-tools.log 2>&1 & )
disown
```

**Operator UI** → type *"Apologize and credit $19.50 to customer of delivery #12345"* → Send.

Agent investigates, asks for finance approval, approver approves. Then:

- `[system] Approved by … Proceeding with apply_credit.`
- (Agent hangs in `calling_tool` state.)

Behind the scenes: `apply_credit` retries 3 times with backoff (~3 seconds), then Restate pauses the invocation per the configured `onMaxAttempts: 'pause'`.

**Pivot to Restate UI** → Invocations → the paused `ApplyCredit/execute` invocation shows in red/orange. Click into it → see the journal, see the error: `amount_cents must be a multiple of 100 (got 1950)`.

**Deploy the patch:** kill the buggy tools service, restart without `BUGGY_MODE`:

```bash
kill $(lsof -nP -iTCP:9082 -sTCP:LISTEN -ti)
( cd services/tools && npm run dev > /tmp/dashops-tools.log 2>&1 & )
disown
```

**Resume the paused invocation:**

In the Restate UI, click the paused invocation → click "Resume" button. Or via curl:

```bash
PAUSED=$(curl -s http://localhost:9070/openapi >/dev/null; echo "<get from UI>")
curl -X PATCH "http://localhost:9070/invocations/${PAUSED}/resume"
```

Watch the operator UI: `[tool · apply_credit]` appears with the credit result. Agent moves on to `customer_outreach`, which lands a second approval — switch dropdown, approve.

Final: `**Action complete for delivery #12345.** Credited $19.50 to Aiyana Patel (credit id …). Sent apology_with_credit message (id …).`

Talking points:
- *That conversation started ten minutes ago. The agent didn't redo any earlier work. The patch ran from exactly the point of failure forward.*
- *In Stephan's words: 'take a failed invocation, inject a patch, resume from exactly that point.' That just happened.*

---

## Notable decisions made overnight (different from the spec)

### Gateway is TypeScript, not Kotlin

The spec called for the gateway to be in Kotlin (matches DoorDash's primary backend language). I started in Kotlin and hit two issues that ate hours:

1. JDK 25 (default Homebrew openjdk) breaks Kotlin 2.0/2.2 — had to pin a JDK 21 toolchain.
2. The Kotlin SDK's dynamic-dispatch API (`Request.of(Target.X, TypeTag.of, …)`) for calling Restate services by string name (which the gateway needs because tools are TS, not generated Kotlin clients) wasn't documented and took significant trial-and-error to find.

For demo velocity, I switched the gateway to TypeScript. Architecturally identical, demo-wise identical. Worth raising with Vasily as: *"This would naturally be Kotlin in your stack — the architecture is the same; we shipped this demo in TS so everything was one language. Restate has Kotlin SDK ready for the port."*

The original Kotlin scaffold lives in git history if you want to point at it.

### Restate runs natively, not in Docker

Docker Desktop's daemon kept dying mid-build (sleep/resource pressure, not investigated deeply). The native `restate-server` binary is installed via Homebrew at the same version (1.6.2). `docker-compose.yml` is still in the repo for users who prefer it, but `scripts/start-all.sh` uses the native binary.

### Polyglot story is deferred

The pitch I'd designed was "TS for agents, Kotlin for platform infrastructure." V1 is all TypeScript. Not a fatal compromise — we can mention this in narration. But if you want to demonstrate polyglot live, porting the gateway to Kotlin is a contained next step.

### `ctx.date.now()` everywhere, not `Date.now()`

The kill-the-process demo (Scene 3 finale) doesn't work if any handler uses `Date.now()` directly — replay produces a different value than the original, and Restate aborts the replay with a "code paths diverged" error. All handlers now use `await ctx.date.now()`. Learned this the hard way; mention if asked about determinism.

### LLM is stubbed, not live

The agent's "LLM" is a pattern-matching state machine in `services/ops-agent/src/llm.ts`. It handles:
- delivery investigation (`what happened with delivery #X`)
- corrective action (`apologize and credit $Y`) — triggers full HITL flow
- semantic search (`find complaints …`) — triggers PII guardrail when params contain PII
- merchant batch (`check merchants for deliveries A, B, C, …`) — triggers rate-limit demo

For a live Anthropic-backed LLM, see `services/ops-agent/src/llm.ts` — would swap `planNext` for a real `messages.create` call with a tool-use schema. Deferred for time.

---

## Deferred (Phase 6 polish, not built)

- **Mock OAuth + Credentials VO** with proactive token refresh. The gateway's pipeline has a comment placeholder for step 7 (credentials); no real implementation. The pattern (`Credentials` VO with `getToken/refresh`, durable timer for proactive refresh, per-key serialization to prevent thundering herd) is well-understood and a half-day port.
- **Live Anthropic LLM** for the agent. Stub mode covers all the demo flows; the LLM client interface is small.
- **Cost ledger UI surface.** The ledger works (`Restate ingress → /CostLedger/{tenant}/summary`); just no dedicated UI page. Surface it via curl in the demo.
- **Approval timeout / escalation timer.** OA-D3 in the design — schedule a `ctx.sleep` reminder + auto-fail in the approval VO. Not built; mention as the natural place this lives.
- **Audit-record query UI.** Approval records are queryable via Restate's `/ApprovalService/{id}/getRecord` — no dedicated UI.

---

## Lessons learned (saved you from re-discovering)

### `lsof -ti:<port>` is dangerous

Without `-sTCP:LISTEN`, lsof returns ALL PIDs with sockets on that port — including *clients* connected to the server. `kill $(lsof -ti:9082)` ended up killing `restate-server` repeatedly because it had open connections to the service discovery endpoint.

Correct form: `lsof -nP -iTCP:9082 -sTCP:LISTEN -ti`.

`scripts/stop-all.sh` uses the safe form.

### Restate Kotlin SDK 2.4.1 requires Kotlin 2.2.x metadata, not 2.0.x

Hit this in Phase 0. Pinned to Kotlin 2.2.10 + KSP 2.2.10-2.0.2. JDK toolchain 21 (not 25).

### `genericCall` defaults to `Uint8Array` serdes

If you don't pass `inputSerde: restate.serde.json` (and `outputSerde`), the parameter is treated as bytes and your typed handler sees `undefined` for the input field. The TypeError stack trace was deceptive — looked like a code bug, was actually a wire format issue.

---

## Repo tour

```
services/
├── shared/             types (CallerIdentity, SessionState, ApprovalRecord, …)
├── gateway/            Gateway, ToolRegistry, CostLedger, TokenBucket — the chokepoint
├── tools/              7 mock MCPs as Restate services
├── ops-agent/          Session VO + reagent loop + web bridge
├── guardrails/         PIIGuardrail
└── approval-service/   ApprovalService + PendingApprovalsIndex

web/
├── operator/           chat UI + status banner + seed chips
└── approver/           approval card dashboard

scripts/
├── start-all.sh        bring everything up + register
├── stop-all.sh         safe shutdown
└── register.sh         register deployments + bootstrap tool registry
```

---

## What to ask in the morning

If anything in here doesn't match expectations:

1. **Want the Kotlin gateway back?** It's a contained port — most of the gateway logic moves into Kotlin with the dynamic-dispatch pattern from the Java examples.
2. **Want the LLM live?** Small swap in `llm.ts`. Could wire to Claude Haiku in 30 lines.
3. **Want the credential VO built?** Half-day; clean addition to the gateway pipeline.
4. **Want a different demo scenario emphasized?** The seed chips in the operator UI are the easy edit point.
5. **Want this dockerized cleanly?** `docker-compose.yml` is still in the repo; was the original plan; Docker just needs to be reliable in your dev env.

Otherwise, I'd suggest dry-running Scenes 1 → 3 → 5 in that order, since those are the strongest beats. Scenes 2 and 4 are good supporting material if Vasily asks the right questions.
