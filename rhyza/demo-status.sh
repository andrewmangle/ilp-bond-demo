#!/usr/bin/env bash
# Shows whether the Rhyza containers, the demo app and its scheduler are up, and the demo clock.
# Also reached as `PAYMENT_RAIL=rhyza scripts/demo-status.sh`.
source "$(dirname "$0")/../scripts/demo-lib.sh"

running=$(docker ps --filter label=com.docker.compose.project=rhyza-bonds --format '{{.Names}}' | wc -l)
total=$(docker ps -a --filter label=com.docker.compose.project=rhyza-bonds --format '{{.Names}}' | wc -l)
echo "Rhyza containers: $running of $total running"
docker ps -a --filter label=com.docker.compose.project=rhyza-bonds --filter status=exited --format '  EXITED {{.Names}}\t{{.Status}}'
echo
if pid=$(app_pid); then echo "Demo app: running (pid $pid, rail $(cat "$DATA_DIR/app.rail" 2>/dev/null || echo rafiki)), log $LOG_FILE"; else echo "Demo app: not running"; fi
if ! health=$(curl -sf -m 10 "$APP_URL/api/demo/health"); then
  echo "Health: the demo app isn't answering at $APP_URL"
  exit 1
fi
echo "$health" | node -e '
  const h = JSON.parse(require("fs").readFileSync(0, "utf8"))
  const up = (c) => (c.ok ? "up" : `DOWN${c.detail ? ` (${c.detail})` : ""}`)
  console.log(`Health: ${h.ok ? "everything up" : "SOMETHING IS DOWN"} (rail: ${h.rail ?? "rafiki"})`)
  for (const n of h.nodes) console.log(`  ${n.label.padEnd(25)} ase-mock ${up(n.checks.mockBank)}, admin API ${up(n.checks.adminApi)}, Open Payments ${up(n.checks.openPayments)}, auth ${up(n.checks.auth)}`)
  const s = h.scheduler
  console.log(`  Scheduler                 ${up(s)}: coupons ${s.lastRunSecondsAgo.coupons} s ago, recurring purchases ${s.lastRunSecondsAgo.plans} s ago`)
  console.log(`Demo clock: day ${h.clock.day}, ${h.clock.paused ? "PAUSED" : `running at ${h.clock.secondsPerDay} s per day`}`)
  console.log(`Demo data: ${h.counts.bonds} bonds, ${h.counts.holdings} holdings, ${h.counts.plans} plans, ${h.counts.payments} payments`)
  process.exit(h.ok ? 0 : 1)
'
