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
  local perMinute="${5:-60}"     # default rate limit
  echo "  Registering tool: ${toolName} -> ${serviceName} (${perMinute}/min)"
  curl -fsS -X POST "${INGRESS}/ToolRegistry/default/register" \
    -H 'Content-Type: application/json' \
    --data "{\"name\":\"${toolName}\",\"serviceName\":\"${serviceName}\",\"handlerName\":\"execute\",\"description\":\"${description}\",\"configuredCostCents\":${configuredCostCents},\"rateLimit\":{\"perMinute\":${perMinute}}}" \
    > /dev/null
}

echo "== Registering deployments =="
register "gateway"          9080
register "tools"            9082
register "ops-agent"        9083
register "guardrails"       9084
register "approval-service" 9085

echo "== Bootstrapping tool registry =="
register_tool "delivery_lookup"    "DeliveryLookup"    "Look up a delivery by ID"            0  60
register_tool "customer_lookup"    "CustomerLookup"    "Look up a customer profile by ID"    0  60
register_tool "escalation_history" "EscalationHistory" "Recent escalations for a delivery"   0  60
register_tool "semantic_search"    "SemanticSearch"    "Find similar past complaints"        5  30
register_tool "apply_credit"       "ApplyCredit"       "Apply a credit to a customer"        0  10
register_tool "customer_outreach"  "CustomerOutreach"  "Send an outreach message"            0  10
register_tool "merchant_status"    "MerchantStatus"    "Get merchant operational status"     0   6   # tight!

echo "All registered."
