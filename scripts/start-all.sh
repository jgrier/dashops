#!/usr/bin/env bash
# Bring the entire DashOps demo up in the background.
# Logs go to /tmp/dashops-*.log.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log_for() { echo "/tmp/dashops-$1.log"; }

is_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -ti >/dev/null 2>&1; }

start_svc() {
  local name="$1" dir="$2" extra_env="${3:-}"
  local logf
  logf="$(log_for "$name")"
  echo "  → starting $name (logs: $logf)"
  ( cd "$dir" && env $extra_env npm run dev > "$logf" 2>&1 ) &
  disown
}

echo "== Bringing up restate-server =="
if is_listening 9070; then
  echo "  (already running)"
else
  ( restate-server --no-logo > "$(log_for restate)" 2>&1 ) &
  disown
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if is_listening 9070; then break; fi
    sleep 1
  done
fi

echo "== Bringing up services =="
is_listening 9080 || start_svc gateway          "$ROOT/services/gateway"
is_listening 9081 || start_svc delivery-svc     "$ROOT/services/delivery-svc"
is_listening 9082 || start_svc customer-svc     "$ROOT/services/customer-svc"   "${TOOLS_ENV:-}"
is_listening 9083 || start_svc ops-agent        "$ROOT/services/ops-agent"
is_listening 9084 || start_svc guardrails       "$ROOT/services/guardrails"
is_listening 9085 || start_svc approval-service "$ROOT/services/approval-service"
is_listening 9086 || start_svc insights-svc     "$ROOT/services/insights-svc"

echo "== Waiting for services to listen =="
for port in 9080 9081 9082 9083 9084 9085 9086; do
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if is_listening "$port"; then break; fi
    sleep 1
  done
done

echo "== Registering deployments =="
# Tool services self-register their tools at startup; we only need to
# register Restate-side deployments here.
sleep 1
bash "$ROOT/scripts/register.sh"

cat <<EOF

All up.

  Restate admin UI : http://localhost:9070
  Operator UI      : http://localhost:3000/operator
  Approver UI      : http://localhost:3000/approver

Logs:
  tail -f /tmp/dashops-restate.log
  tail -f /tmp/dashops-gateway.log
  tail -f /tmp/dashops-delivery-svc.log
  tail -f /tmp/dashops-customer-svc.log
  tail -f /tmp/dashops-ops-agent.log
  tail -f /tmp/dashops-guardrails.log
  tail -f /tmp/dashops-approval-service.log
  tail -f /tmp/dashops-insights-svc.log
EOF
