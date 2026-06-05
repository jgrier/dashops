# DashOps on Restate

A DoorDash-flavored agent platform demo: an operator agent that investigates and corrects operational issues, fronted by an agent gateway that owns auth, rate limits, cost attribution, and approval policy. Built on Restate.

Status: scaffolding (Phase 0). See `tasks` for build progress.

## Stack

- **Ops agent** (TypeScript) — reagent loop, durable workflow per request
- **Agent gateway** (Kotlin) — policy enforcement, rate limits, cost ledger, registry
- **Approval service** (TypeScript) — async HITL approval lifecycle
- **Tools, PII guardrail, mock OAuth** (TypeScript) — supporting services
- **Operator + approver web UIs** (TypeScript)
- **Restate 1.6.2** — durable invocations, journals, pause/resume, awakeables

## Run

```bash
docker compose up -d              # start Restate
# (service start commands added per phase)
```

Restate admin UI: <http://localhost:9070> · Ingress: <http://localhost:8080>
