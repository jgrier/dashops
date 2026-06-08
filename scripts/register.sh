#!/usr/bin/env bash
# Register all running deployments with Restate. Tool entries (gateway's
# ToolRegistry) are no longer registered here — each tool service self-
# registers its tools at startup (see services/*-svc/src/index.ts).
set -euo pipefail

ADMIN="${ADMIN:-http://localhost:9070}"
HOST="${HOST:-localhost}"

register() {
  local name="$1"
  local port="$2"
  local uri="http://${HOST}:${port}"
  echo "Registering ${name} at ${uri}"
  curl -fsS -X POST "${ADMIN}/deployments" \
    -H 'Content-Type: application/json' \
    --data "{\"uri\":\"${uri}\",\"force\":true}" \
    > /dev/null
}

echo "== Registering deployments =="
register "gateway"          9080
register "delivery-svc"     9081
register "customer-svc"     9082
register "ops-agent"        9083
register "guardrails"       9084
register "approval-service" 9085
register "insights-svc"     9086
register "llm-svc"          9087

echo "All deployments registered. Tools self-register from each service."
