# DashOps on Restate

A DoorDash-flavored agent platform demo: an **operator agent** that investigates and corrects operational issues, fronted by an **agent gateway** that owns auth, rate limits, cost attribution, and approval policy. Built on Restate.

**For the morning walkthrough, see [DEMO.md](./DEMO.md).** It covers all five demo scenes, talking points, design decisions made overnight, and lessons learned.

## Status

All five demo scenes work end-to-end:

1. **Insight mode** — multi-step investigation through the gateway, fully journaled in Restate
2. **PII guardrail** — middleware blocks calls whose params contain PII patterns
3. **Async HITL approval** — agent suspends for arbitrary time on an awakeable, resumes on different process
4. **Hierarchical token-bucket rate limits** — `ctx.sleep` instead of client-side retry
5. **Failure / patch / replay** — `apply_credit` fails 3x, pauses; restart with fix, resume from failure point

## Run

```bash
bash scripts/start-all.sh
```

- Operator UI: <http://localhost:3000/operator>
- Approver UI: <http://localhost:3000/approver>
- Restate admin UI: <http://localhost:9070>

Stop:

```bash
bash scripts/stop-all.sh
```

## Stack

- **Restate 1.6.2** — durable invocations, virtual objects, awakeables, durable timers, pause/resume, journal-based replay
- **TypeScript everywhere** — `@restatedev/restate-sdk` v1.14.5; one repo, npm workspaces
- **Vanilla HTML+JS** for both web UIs — no bundler, polling-based state sync

## Architecture

Six Restate services, two web UIs, one bridge:

| Service | Role |
|---|---|
| `Session` (VO per session_id) | Operator chat state + reagent loop |
| `Gateway` (service) | Pipeline chokepoint: registry → guardrails → policy → rate limit → identity → dispatch → cost |
| `ToolRegistry` (VO) | Dynamic tool registration |
| `CostLedger` (VO per tenant) | Per-tenant cost ledger |
| `TokenBucket` (VO per resource) | Hierarchical rate limits (global / tenant / tenant_tool) |
| `Tools` (7 Restate services) | Mock MCPs — `DeliveryLookup`, `CustomerLookup`, `EscalationHistory`, `SemanticSearch`, `ApplyCredit`, `CustomerOutreach`, `MerchantStatus` |
| `PIIGuardrail` (service) | Regex-based PII detection middleware |
| `ApprovalService` (VO per approval_id) | Awakeable handle + audit |
| `PendingApprovalsIndex` (VO per group) | UI poll source |

Everything flows through Restate's ingress; every hop is durable.

## What this demonstrates for DoorDash

- **Durable mesh** — every agent ↔ tool ↔ approval-service ↔ ledger call is journaled in Restate. No retries to write. The Restate UI is the single source of observability across the whole agent path.
- **Async HITL is a first-class primitive** — `ctx.awakeable()` + resolve from anywhere. The agent invocation can sit suspended for arbitrary time and resume on a different process.
- **"Queue, don't retry"** — when a tool is rate-limited, the gateway's handler is durably suspended on `ctx.sleep` until tokens are available. Answers the question Vasily raised in the call about who handles retry.
- **Pause / patch / replay** — Restate 1.6's default behavior on exhausted retries (`onMaxAttempts: 'pause'`) plus the admin API's `PATCH /invocations/{id}/resume` lets you ship a fix and replay from the failure point. No work redone.

See [DEMO.md](./DEMO.md) for the full walkthrough.
