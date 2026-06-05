#!/usr/bin/env bash
# Register all running deployments with Restate.
# Services run on host; Restate (in docker) reaches them via host.docker.internal.
set -euo pipefail

ADMIN="${ADMIN:-http://localhost:9070}"
HOST="${HOST:-host.docker.internal}"

register() {
  local name="$1"
  local port="$2"
  local uri="http://${HOST}:${port}"
  echo "Registering ${name} at ${uri}"
  curl -fsS -X POST "${ADMIN}/deployments" \
    -H 'Content-Type: application/json' \
    --data "{\"uri\":\"${uri}\",\"force\":true}" \
    | python3 -m json.tool || echo "  (failed)"
}

# Phase 0: hello-worlds
register "hello-ts" 9081
register "gateway-kotlin" 9080
