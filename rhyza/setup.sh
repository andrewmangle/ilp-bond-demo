#!/usr/bin/env bash
# Two-node Rhyza playground for the ILP bond demo.
# Usage: ./rhyza/setup.sh [up|down|reset|status|logs <service>]
set -euo pipefail

# Rhyza is alpha and its API changes weekly. This commit is the one the
# scripts in this folder were written against. Bump it deliberately.
RHYZA_REF="${RHYZA_REF:-259a9b94fb8feb14882997ed69cc188f905ad68b}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/.rhyza-src"

# Observability (Grafana, Prometheus, Tempo, nginx) is left off to save RAM.
# Set RHYZA_OBSERVABILITY=1 to turn it on.
PROFILE=()
[[ "${RHYZA_OBSERVABILITY:-0}" == "1" ]] && PROFILE=(--profile with-observability)

compose() {
  docker compose -p rhyza-bonds "${PROFILE[@]}" \
    -f "$SRC/docker/docker-compose.yaml" \
    -f "$SRC/docker/docker-compose.node-b.yaml" \
    -f "$HERE/docker-compose.override.yaml" "$@"
}

fetch_src() {
  if [[ ! -d "$SRC/.git" ]]; then
    git clone https://github.com/interledger/rhyza.git "$SRC"
  fi
  git -C "$SRC" fetch --quiet origin
  git -C "$SRC" checkout --quiet "$RHYZA_REF"
  git -C "$SRC" submodule update --init --recursive
}

case "${1:-up}" in
  up)
    fetch_src
    compose up -d --build
    echo
    echo "Node A (US)          admin http://localhost:3001   open payments http://localhost:3002"
    echo "Node B (Netherlands) admin http://localhost:4001   open payments http://localhost:4002"
    echo "Kafka consoles       http://localhost:8080 (A)     http://localhost:8081 (B)"
    echo "Next: node rhyza/seed.mjs && node rhyza/bond-smoke-test.mjs"
    ;;
  down)   compose down ;;
  reset)  compose down --volumes; rm -f "$HERE/.state.json"; echo "Data wiped. Run: ./rhyza/setup.sh up" ;;
  status) compose ps ;;
  logs)   shift; compose logs -f "$@" ;;
  *) echo "Usage: $0 [up|down|reset|status|logs <service>]"; exit 1 ;;
esac
