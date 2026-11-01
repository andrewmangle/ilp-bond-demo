#!/usr/bin/env bash
# Starts the three Rafiki nodes (Docker), waits until they are up and seeded, starts the demo app and prints
# the URLs. Safe to run again: whatever is already running is left alone.
source "$(dirname "$0")/demo-lib.sh"

echo "Starting the Rafiki nodes (Docker)…"
pnpm -s localenv:compose up -d >/dev/null 2>&1 || pnpm localenv:compose up -d
echo "Waiting for them:"
wait_for "HBCU admin API" http://localhost:3001/healthz
wait_for "Hague admin API" http://localhost:4001/healthz
wait_for "Cape Town admin API" http://localhost:5001/healthz
wait_for "HBCU auth" http://localhost:3006/discovery
wait_for "Hague auth" http://localhost:4006/discovery
wait_for "Cape Town auth" http://localhost:5006/discovery
wait_for_seeded "HBCU mock bank" 3030
wait_for_seeded "Hague mock bank" 3031
wait_for_seeded "Cape Town mock bank" 3032

if pid=$(app_pid); then
  echo "Demo app already running (pid $pid)"
else
  echo "Starting the demo app (log: $LOG_FILE)…"
  nohup node "$APP_DIR/server.js" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
fi
wait_for "Demo app" "$APP_URL/api/demo/health" 60
printf '  %-28s' "Health check"
for _ in $(seq 1 30); do
  if curl -sf -m 10 "$APP_URL/api/demo/health" | grep -q '^{"ok":true'; then echo "all green"; break; fi
  sleep 1
done
curl -sf -m 10 "$APP_URL/api/demo/health" | grep -q '^{"ok":true' || { echo "NOT GREEN: run scripts/demo-status.sh"; }

cat <<URLS

Ready. The demo clock carries on from where it was; resume it on the Control page if it is paused.
  Students      $APP_URL/
  Bond Market   $APP_URL/bonds
  Central Bank  $APP_URL/central-bank
  Live feed     $APP_URL/live
  Control       $APP_URL/control
URLS
