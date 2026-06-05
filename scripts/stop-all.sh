#!/usr/bin/env bash
# Bring down all DashOps services + restate-server.
# IMPORTANT: filters lsof to LISTENING sockets only — without
# -sTCP:LISTEN, lsof also returns PIDs that have client sockets
# connected to that port, which can include restate-server itself
# and cause the whole mesh to fall over.

kill_listener() {
  local port="$1"
  local pids
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -ti 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "  kill :$port  pids=$pids"
    kill $pids 2>/dev/null || true
  fi
}

echo "== Stopping all DashOps services =="
for port in 3000 9080 9082 9083 9084 9085; do
  kill_listener "$port"
done

echo "== Stopping restate-server =="
kill_listener 9070
kill_listener 9071
kill_listener 8080

echo "done."
