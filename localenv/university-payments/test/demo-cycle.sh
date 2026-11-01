#!/usr/bin/env bash
# Full-cycle test: start, seed, Phase 2-4 actions, stop everything (and remove the containers, like a reboot
# would lose them from memory), wait, start again, and check everything came back and payments resume.
# About 5 minutes. Wipes the demo (it seeds).
set -euo pipefail
cd "$(dirname "$0")/../../.."
T=localenv/university-payments/test

scripts/demo-start.sh
node $T/demo-cycle.mjs before
scripts/demo-stop.sh
echo "Removing the containers (data volumes stay), then waiting 60 s with everything off…"
pnpm -s localenv:compose down >/dev/null 2>&1
sleep 60
scripts/demo-start.sh
node $T/demo-cycle.mjs after
