#!/usr/bin/env bash
# Register all running deployments with Restate and bootstrap the tool registry.
# Services run on host; Restate (in docker) reaches them via host.docker.internal.
set -euo pipefail

ADMIN="${ADMIN:-http://localhost:9070}"
INGRESS="${INGRESS:-http://localhost:8080}"
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

register_tool() {
  local toolName="$1"
  local serviceName="$2"
  local description="$3"
  local configuredCostCents="$4"
  echo "  Registering tool: ${toolName} -> ${serviceName}"
  curl -fsS -X POST "${INGRESS}/ToolRegistry/default/register" \
    -H 'Content-Type: application/json' \
    --data "{\"name\":\"${toolName}\",\"serviceName\":\"${serviceName}\",\"handlerName\":\"execute\",\"description\":\"${description}\",\"configuredCostCents\":${configuredCostCents}}" \
    > /dev/null
}

echo "== Registering deployments =="
register "gateway"    9080
register "tools"      9082
register "ops-agent"  9083
register "guardrails" 9084

echo "== Bootstrapping tool registry =="
register_tool "delivery_lookup"    "DeliveryLookup"    "Look up a delivery by ID"           0
register_tool "customer_lookup"    "CustomerLookup"    "Look up a customer profile by ID"   0
register_tool "escalation_history" "EscalationHistory" "Recent escalations for a delivery"  0
register_tool "semantic_search"    "SemanticSearch"    "Find similar past complaints"       5

echo "All registered."
