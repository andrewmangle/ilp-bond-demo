# Shared by the demo-*.sh scripts. Paths are relative to the repo root.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
APP_DIR=localenv/university-payments
DATA_DIR=$APP_DIR/data
PID_FILE=$DATA_DIR/app.pid
LOG_FILE=$DATA_DIR/app.log
APP_URL=http://localhost:${PORT:-3040}
mkdir -p "$DATA_DIR"

app_pid() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null && cat "$PID_FILE"
}

# wait_for <label> <url> [seconds]
wait_for() {
  local label=$1 url=$2 limit=${3:-180}
  printf '  %-28s' "$label"
  for _ in $(seq 1 "$limit"); do
    if curl -sf -o /dev/null -m 3 "$url"; then echo "up"; return 0; fi
    sleep 1
  done
  echo "NOT UP after ${limit} s ($url)"
  return 1
}

# A mock bank is ready once it has seeded: its accounts list includes the treasury
wait_for_seeded() {
  local label=$1 port=$2 limit=${3:-180}
  printf '  %-28s' "$label"
  for _ in $(seq 1 "$limit"); do
    if curl -sf -m 3 "http://localhost:$port/?_data=routes%2F_index" | grep -q accounts/treasury; then echo "up"; return 0; fi
    sleep 1
  done
  echo "NOT UP after ${limit} s"
  return 1
}
