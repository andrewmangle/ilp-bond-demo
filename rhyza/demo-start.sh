#!/usr/bin/env bash
# Starts the Rhyza version of the demo: the two-node Rhyza playground (Docker), its peers and liquidity
# (rhyza/seed.mjs, safe to re-run), then the demo app with PAYMENT_RAIL=rhyza, and prints the URLs.
# Also reached as `PAYMENT_RAIL=rhyza scripts/demo-start.sh`. The Rafiki stack must be stopped first.
source "$(dirname "$0")/../scripts/demo-lib.sh"
RAIL_FILE=$DATA_DIR/app.rail

if docker ps --format '{{.Names}}' | grep -q '^rafiki-'; then
  echo "The Rafiki stack is running and uses the same ports. Stop it first: scripts/demo-stop.sh"
  exit 1
fi
if pid=$(app_pid) && [ "$(cat "$RAIL_FILE" 2>/dev/null || echo rafiki)" != rhyza ]; then
  echo "The demo app is running on the Rafiki rail (pid $pid). Stop it first: scripts/demo-stop.sh"
  exit 1
fi

echo "Starting the Rhyza nodes (Docker; the first build takes a while, log: $DATA_DIR/rhyza-up.log)…"
./rhyza/setup.sh up >"$DATA_DIR/rhyza-up.log" 2>&1 || { echo "setup.sh up failed: see $DATA_DIR/rhyza-up.log"; exit 1; }
echo "Waiting for them:"
wait_for "Node A admin API (HBCU)" http://localhost:3001/assets
wait_for "Node B admin API (Hague)" http://localhost:4001/assets

printf '  %-28s' "Peers and liquidity"
for attempt in 1 2 3 4 5; do
  if node rhyza/seed.mjs >"$DATA_DIR/rhyza-seed.log" 2>&1; then echo "ready"; break; fi
  [ "$attempt" = 5 ] && { echo "FAILED: see $DATA_DIR/rhyza-seed.log"; exit 1; }
  sleep 10
done

if pid=$(app_pid); then
  echo "Demo app already running on the Rhyza rail (pid $pid)"
else
  echo "Starting the demo app on the Rhyza rail (log: $LOG_FILE)…"
  PAYMENT_RAIL=rhyza nohup node "$APP_DIR/server.js" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  echo rhyza >"$RAIL_FILE"
fi
wait_for "Demo app" "$APP_URL/api/demo/health" 60
printf '  %-28s' "Health check"
for _ in $(seq 1 30); do
  if curl -sf -m 10 "$APP_URL/api/demo/health" | grep -q '^{"ok":true'; then echo "all green"; break; fi
  sleep 1
done
curl -sf -m 10 "$APP_URL/api/demo/health" | grep -q '^{"ok":true' || { echo "NOT GREEN: run rhyza/demo-status.sh"; }

cat <<URLS

Ready (Rhyza rail). Seed a starting point with: scripts/demo-reset.sh --seed
  Students      $APP_URL/
  Bond Market   $APP_URL/bonds
  Central Bank  $APP_URL/central-bank
  Live feed     $APP_URL/live
  Control       $APP_URL/control
URLS
