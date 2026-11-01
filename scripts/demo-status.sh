#!/usr/bin/env bash
# Shows whether the Rafiki containers, the demo app and its scheduler are up, and the demo clock.
source "$(dirname "$0")/demo-lib.sh"

echo "Containers:"
docker ps -a --filter name=rafiki- --format '  {{.Names}}\t{{.Status}}' | sort
echo
if pid=$(app_pid); then echo "Demo app: running (pid $pid), log $LOG_FILE"; else echo "Demo app: not running"; fi
if ! health=$(curl -sf -m 10 "$APP_URL/api/demo/health"); then
  echo "Health: the demo app isn't answering at $APP_URL"
  exit 1
fi
echo "$health" | node -e '
  const h = JSON.parse(require("fs").readFileSync(0, "utf8"))
  const up = (c) => (c.ok ? "up" : `DOWN${c.detail ? ` (${c.detail})` : ""}`)
  console.log(`Health: ${h.ok ? "everything up" : "SOMETHING IS DOWN"}`)
  for (const n of h.nodes) console.log(`  ${n.label.padEnd(15)} mock bank ${up(n.checks.mockBank)}, admin API ${up(n.checks.adminApi)}, Open Payments ${up(n.checks.openPayments)}, auth ${up(n.checks.auth)}`)
  const s = h.scheduler
  console.log(`  Scheduler       ${up(s)}: coupons ${s.lastRunSecondsAgo.coupons} s ago, recurring purchases ${s.lastRunSecondsAgo.plans} s ago`)
  console.log(`Demo clock: day ${h.clock.day}, ${h.clock.paused ? "PAUSED" : `running at ${h.clock.secondsPerDay} s per day`}`)
  console.log(`Demo data: ${h.counts.bonds} bonds, ${h.counts.holdings} holdings, ${h.counts.plans} plans, ${h.counts.payments} payments`)
  process.exit(h.ok ? 0 : 1)
'
