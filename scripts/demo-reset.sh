#!/usr/bin/env bash
# Resets the demo: wipes the demo app's data and returns the mock banks to their seeded state.
#   scripts/demo-reset.sh          reset, after asking
#   scripts/demo-reset.sh --seed   reset and seed the demo's starting point (treasuries, students, Amara's bond)
#   add -y to skip the question
# Needs everything running (scripts/demo-start.sh).
source "$(dirname "$0")/demo-lib.sh"

action=reset; yes=no
for arg in "$@"; do
  case $arg in
    --seed) action=seed ;;
    -y|--yes) yes=yes ;;
    *) echo "Unknown option $arg"; exit 2 ;;
  esac
done

app_pid >/dev/null || { echo "The demo app isn't running: start it with scripts/demo-start.sh"; exit 1; }
if [ "$yes" != yes ]; then
  read -r -p "This wipes all bonds, holdings, grants, plans and balances. Type 'reset' to go on: " answer
  [ "$answer" = reset ] || { echo "Nothing changed"; exit 1; }
fi

echo "Running $action (the mock banks restart; about half a minute)…"
curl -sf -m 300 -X POST -H 'content-type: application/json' -H 'x-acting-as: bank:hbcu' \
  -d '{"confirm":true}' "$APP_URL/api/demo/$action" | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"))
    const f = (a) => `${(Number(a.value) / 10 ** a.assetScale).toFixed(a.assetScale)} ${a.assetCode}`
    if (r.bond) {
      console.log(`Seeded: treasuries ${Object.values(r.treasuries).map(f).join(", ")}`)
      for (const s of r.students) console.log(`  ${s.name} (${s.nodeLabel}): ${f(s.balance)}  ${s.walletAddress}`)
      console.log(`  ${r.bond.name}: ${f(r.bond.size)} at ${r.bond.annualRate}% for ${r.bond.termDays} days, ${r.bond.lifecycleLabel}`)
    } else console.log(`Reset in ${r.seconds} s; demo clock on day ${r.clock.day}`)
  ' || { echo "Failed: see $LOG_FILE"; exit 1; }
