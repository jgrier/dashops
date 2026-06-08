# DashOps demo — narrative for reviewers

A small reference platform built on [Restate](https://restate.dev) that shows how to host an agentic application without rebuilding the durability, policy, and human-in-the-loop machinery yourself. Read this before watching the demo so you'll know what each thing on screen is meant to prove.

The mock domain is food-delivery operations — an "operator agent" investigates flagged deliveries and proposes corrective actions (credits, apology messages, merchant status checks). The domain isn't the point. The point is the platform underneath: what does it look like to build an agent on a runtime that makes every call durable, every approval async-and-resumable, every guardrail centralized, and every process kill-and-restartable?

## The shape of the platform in one breath

A human operator talks to a per-session agent. The agent calls tools and an LLM. Every one of those calls flows through a single **gateway** that enforces policy, records cost, rate-limits, and audits. The gateway is fronted by a **BFF** that serves every browser-facing page. Behind it all sits the **Restate runtime**, which makes every invocation durable, lets handlers suspend for hours on human approvals, and replays journaled work after any process death.

A terminal-based **supervisor** spawns every process in the system — Restate itself, the BFF, all eight application services — and lets you kill or restart any of them with one keystroke. That's how we'll inject failures live during the demo.

See the architecture diagram and process inventory in [README.md](./README.md) — this doc is the narrative; that one is the structural reference.

## How to follow along

When the demo runs, two browser tabs will be open:

- <http://localhost:3001/operator> — the operator chat. This is where the action happens.
- <http://localhost:3001/approver> — the approver inbox. The approver is a different role; in this demo we'll switch tabs to play both parts.

A third surface worth pulling up:

- <http://localhost:3001/services> — a portal of "ops pages" for each service. Per-service state — registered tools, recent gateway calls, durable token-bucket fill, per-tenant cost — is all visible here. The same data the platform team would use in production.

A fourth, when we want to prove durability:

- <http://localhost:9070/ui/> — Restate's own admin UI. Shows the invocation journal for every call. The gateway's recent-calls table deep-links into this.

And a fifth, in the terminal where the demo was launched:

- The **supervisor TUI** — a live table of every supervised process. This is where we'll kill and restart things during the failure-injection finale.

## The four scenes you'll see

### 1. An ordinary agent turn

In the operator UI: *"What happened with delivery #12345?"*

The agent does what a human ops engineer would: looks up the delivery, pulls the escalation history, gets the customer profile, decides there's an unresolved complaint, and writes a summary. Three tool calls and a final reply.

**What to watch:** open the gateway ops page (`/ops/gateway`) while this runs. You'll see four rows appear in the "recent calls" table, **grouped under a single colored cluster** — that's "one operator click = one agent turn", made visible because the agent's session id propagates as a `traceId` through every downstream call. Each row has a timestamp that deep-links to the Restate admin UI; click one to see the durable journal of that call.

**The point:** the gateway is in the path of every external action the agent took. We didn't have to instrument anything in the agent or the tool services to get this visibility. The audit log, the cost ledger, the rate-limit decision, the deep-link to the journal — they all came from one centralized chokepoint.

### 2. An action that needs human approval

In the operator UI: *"Apologize and credit $20 to the customer of delivery #12345"*

The agent walks through the same investigation, then proposes `apply_credit($20)`. The gateway's approval policy sees an amount above $10 and returns `needs_approval`. The agent **suspends** on an awakeable — its handler stops mid-execution, waiting on a future resolution.

Switch to the approver tab. A new card has appeared in the `finance-leads` queue. The approver clicks Approve. The awakeable resolves, the agent's `sendMessage` handler picks up where it left off, retries the gateway call with a fingerprint-bound approval token, completes the credit, then writes its summary reply.

**What to watch:** the operator tab's input field grays out (`Waiting on approval decision…`) while the agent is suspended. The approver tab's `finance-leads` pill shows a count badge. The "Decided" sub-tab in the approver UI keeps a durable audit log of every decision — same data lives in a `DecidedApprovalsIndex` VO per group.

**The point that matters most:** the agent's handler can sit suspended for an arbitrarily long time. Kill `ops-agent` mid-suspension from the supervisor TUI and the approval still completes successfully — the runtime stores the awakeable and resumes the handler on a fresh process. This is not retry-with-checkpointing; it's *the same invocation, paused on disk, picking back up from exactly the right line of code*.

### 3. A guardrail that blocks, and the appeal path

In the operator UI: *"find similar complaints from customer at 555-867-5309"*

The agent decides to call `semantic_search`. The gateway's PII middleware runs its classifier — sees a phone number in the parameters — and returns `block_appealable`. The chat shows a system message: **"Blocked by pii-guardrail: Detected possible PII…"** with a button: **"Request review from ops-managers"**.

The operator clicks it. The agent fires off a new approval request to a *different* approver group (`ops-managers`, not `finance-leads` this time — different policy concerns, different humans).

Switch to the approver tab and pick the `ops-managers` group. The pending row carries an **APPEAL** chip — same UI for approvals and appeals, but flagged differently so the reviewer knows what they're being asked. Click Approve. The agent retries the call with an *appeal token* — bound to the exact call by a fingerprint of `(toolName, params)` — and the gateway, after verifying the token, lets this one call bypass the PII middleware. The search completes; the agent finishes its turn.

**The point:** safety middleware that *blocks but offers an escape hatch* is a real platform requirement. The gateway implements it generically — any future middleware can return `block_appealable` and route to whichever approver group is appropriate. The token verification is the same machinery as a normal approval; the only difference is which middleware gets selectively bypassed.

### 4. Durable queueing under rate limit

In the operator UI: *"check merchants for deliveries 12345, 12346, 12399"*

The agent fires three `merchant_status` calls in sequence. The tool's rate limit is **6 per minute**, so the first calls go through instantly. To make the queueing visible, fire a bigger burst (12+ rapid calls) and the gateway has to start sleeping.

What happens when a bucket runs out: the gateway's rate-limit middleware calls `ctx.sleep(waitMs)`. This is **durable sleep** — the invocation pauses; if the gateway crashes mid-sleep, the wake-up still happens on the new process exactly when it was scheduled. No client-side retry loop anywhere.

**Open `/ops/gateway` and scroll to the "Rate-limit buckets" section while the burst runs.** You'll see `merchant_status` drain from 6 to 0 in one refresh, then climb back up by one token every 10 seconds — the tokens are computed live, not stored stale. Each row also has live `−` / `+` buttons — you can drop the rate limit from 6 to 2 while the demo is running and watch the next call back up even further. (The change writes through to a durable VO; restarting the service preserves it.)

**The point:** rate limits aren't a property of any individual tool or any individual client — they're a platform concern enforced once, with durable queueing as the default. The agent code is identical whether the call goes through instantly or sleeps for 30 seconds.

## The finale — pull every pin

This is optional depending on time, but it's the most visceral demonstration of what "durable" actually means.

**Setup:** trigger a needs-approval action ("Apologize + $20 credit") and stop at the moment the agent is suspended on the approval awakeable.

**In the supervisor TUI, press `k` on, in order:**

1. `ops-agent` — the agent process is now dead
2. `approval-service` — the approval state appears unreachable
3. `gateway` — the gateway is unreachable
4. `llm-svc` — the LLM service is unreachable
5. `restate-server` — *the runtime itself is dead*

Every browser surface now shows errors. From the outside this looks unrecoverable.

**Now press `s` on each, in roughly the reverse order**: `restate-server`, then `approval-service`, `gateway`, `llm-svc`, `ops-agent`.

Switch to the approver tab and reload. **The pending approval is still there**, exactly as it was before the world ended. Click Approve.

In the operator tab: the suspended agent picks back up from journal, completes the credit, replays the rest of its turn, writes the closing reply. The chat now shows the action completed as if nothing happened.

**What this proves:**

- Every VO's state survived the runtime restart — chat history, pending approval, cost ledger entries.
- The suspended handler resumed *from the right line of code*. No work was redone. No work was lost.
- The approval's awakeable was reachable again the moment its service came back, even though the runtime had been killed in between.
- The supervisor's TUI is the entire failure-injection control plane. No special tooling.

You can do simpler variants on the same theme — kill just `gateway` and watch in-flight calls hang until you bring it back, then succeed; kill `bff` and the chat UI goes dark but no state is lost. The fullest version is the most memorable, time permitting.

## What's not part of the script but is in the codebase

A few things present in the repo but not part of the demo arc, in case anyone notices and asks:

- **Live LLM mode.** All LLM calls today use deterministic stubs so the demo is reproducible. Setting `ANTHROPIC_API_KEY` flips `llm-svc` to a real Anthropic SDK call without changing any caller. Not showing this tomorrow but it's a one-env-var flip.
- **`apply_credit` buggy mode.** There's an `onMaxAttempts: pause` configuration on the credit tool that combines with a deliberate non-whole-dollar bug under `BUGGY_MODE=1` to demonstrate "fail 3× → pause invocation → patch the code → resume from the failure point." This is the strongest single demo of Restate's pause/replay capability, but it requires editing a file mid-demo, which is awkward to script. Probably skip; mention if someone asks "what about deploys with bugs?"
- **Multi-tenant cost.** Today the demo runs as one operator tenant. The `CostLedger` is keyed by tenant id; the platform itself is *already* its own tenant — every PII-classifier LLM call bills the `platform` tenant rather than the operator, so the cost ledger page on `/ops/gateway` shows two cards: one for the operator, one for the platform's own overhead. Worth pointing out — a real production system bills cross-cutting safety to the platform, not the user.

## One-line take-aways

- **Building agent platforms on Restate gets you durable execution, awakeable-based human-in-the-loop, and journal-based observability essentially for free.**
- **The single biggest architectural payoff is the gateway pattern** — route every tool call AND every LLM call through one chokepoint. Cost, policy, rate limits, audit, and approvals stop being everybody's problem.
- **Operationally durable means literally durable** — the system survives killing every process, including the runtime itself, with no work lost. That's the demo finale.
