#!/usr/bin/env bash
# Stops the demo app and the Rhyza playground. Nothing is lost: the app's data (data/demo-rhyza.db) and the
# Rhyza databases are kept. Also reached as `PAYMENT_RAIL=rhyza scripts/demo-stop.sh`.
source "$(dirname "$0")/../scripts/demo-lib.sh"

if pid=$(app_pid); then
  echo "Stopping the demo app (pid $pid)…"
  kill "$pid"
  for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && { echo "  still running, killing it"; kill -9 "$pid"; }
  rm -f "$PID_FILE"
else
  echo "Demo app not running"
fi
rm -f "$DATA_DIR/app.rail"
echo "Stopping the Rhyza containers…"
./rhyza/setup.sh down >/dev/null 2>&1 || ./rhyza/setup.sh down
echo "Stopped. Start again with rhyza/demo-start.sh (or scripts/demo-start.sh for the Rafiki demo)"
