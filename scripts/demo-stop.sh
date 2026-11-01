#!/usr/bin/env bash
# Stops the demo app (cleanly: a payment run in progress finishes first) and the Rafiki containers.
# Nothing is lost: the app's data, the mock banks' accounts and Rafiki's databases are all kept, and the demo
# clock doesn't move while everything is stopped.
source "$(dirname "$0")/demo-lib.sh"

if pid=$(app_pid); then
  echo "Stopping the demo app (pid $pid)…"
  kill "$pid"
  for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && { echo "  still running, killing it"; kill -9 "$pid"; }
  rm -f "$PID_FILE"
else
  echo "Demo app not running"
fi
echo "Stopping the Rafiki containers…"
pnpm -s localenv:compose stop >/dev/null 2>&1 || pnpm localenv:compose stop
echo "Stopped. Start again with scripts/demo-start.sh"
