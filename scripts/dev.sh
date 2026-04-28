#!/usr/bin/env bash
# Dev launcher for the Python hub and Next.js web frontend.
#
# Usage:
#   scripts/dev.sh                          start both (default)
#   scripts/dev.sh start    [hub|web|all]   start (no-op if already running)
#   scripts/dev.sh stop     [hub|web|all]   stop
#   scripts/dev.sh restart  [hub|web|all]   stop then start
#   scripts/dev.sh status   [hub|web|all]   show running state
#   scripts/dev.sh logs     [hub|web]       tail the log file
#
# Hub parameters — override via environment variable before calling this script:
#   HUB_HOST=0.0.0.0        scripts/dev.sh start hub   # LAN-accessible
#   HUB_NO_AUTH=1           scripts/dev.sh start hub   # disable token auth
#   HUB_TOKEN=mytoken       scripts/dev.sh start hub   # fixed token
#   HUB_TRANSPORT=ble       scripts/dev.sh start hub   # hardware transport
#   HUB_BUDGET=400000       scripts/dev.sh start hub   # context window budget
#
# State directory: /tmp/claude-code-buddy/{hub,web}.{pid,log}

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="/tmp/claude-code-buddy"
mkdir -p "$RUN_DIR"

# ── Hub CLI parameters (env-var overridable) ─────────────────────────────────
HUB_HOST="${HUB_HOST:-127.0.0.1}"
HUB_PORT="${HUB_PORT:-7381}"          # HTTP hook listener
HUB_WS_PORT="${HUB_WS_PORT:-7382}"   # WebSocket push (used for liveness check)
HUB_TRANSPORT="${HUB_TRANSPORT:-none}"
HUB_BUDGET="${HUB_BUDGET:-200000}"
# HUB_TOKEN="yourtoken"               # set to pin the token across restarts
# HUB_NO_AUTH=1                       # set to any non-empty value to disable auth

# ── Service directories ───────────────────────────────────────────────────────
hub_dir="$REPO_ROOT/server/python"
web_dir="$REPO_ROOT/web"

pidf() { echo "$RUN_DIR/$1.pid"; }
logf() { echo "$RUN_DIR/$1.log"; }

port_for() {
  case "$1" in hub) echo "$HUB_WS_PORT" ;; web) echo "3000" ;; esac
}

# Port-listener check is authoritative — a stale PID file from a crashed
# process would otherwise lie about service state.
port_pid() {
  lsof -i ":$(port_for "$1")" -sTCP:LISTEN -t 2>/dev/null | head -1
}

is_running() { [[ -n "$(port_pid "$1")" ]]; }

# Reprint the hub's access banner (URLs + token) from its log to stdout so
# the developer can copy a URL without tailing the log manually.
print_hub_banner() {
  local log
  log="$(logf hub)"
  local urls tok_line
  urls="$(grep -E '^    http://' "$log" 2>/dev/null || true)"
  tok_line="$(grep -E 'WebSocket token:' "$log" 2>/dev/null | tail -1 || true)"
  if [[ -n "$urls" ]]; then
    printf '\n  Access:\n'
    echo "$urls"
    [[ -n "$tok_line" ]] && printf '  %s\n' "$tok_line"
    printf '\n'
  fi
}

# Build the hub command from env vars, only including flags that differ from
# hub defaults so the log shows a clean, readable invocation.
hub_cmd() {
  local cmd=(uv run python -m hub)
  cmd+=(--transport "$HUB_TRANSPORT")
  cmd+=(--port      "$HUB_PORT")
  cmd+=(--ws-port   "$HUB_WS_PORT")
  [[ "$HUB_HOST" != "127.0.0.1" ]]  && cmd+=(--host   "$HUB_HOST")
  [[ -n "${HUB_TOKEN:-}"  ]]        && cmd+=(--token   "$HUB_TOKEN")
  [[ -n "${HUB_NO_AUTH:-}" ]]       && cmd+=(--no-auth)
  [[ "$HUB_BUDGET" != "200000" ]]   && cmd+=(--budget  "$HUB_BUDGET")
  echo "${cmd[@]}"
}

start_one() {
  local svc="$1"
  if is_running "$svc"; then
    echo "[$svc] already running (pid $(port_pid "$svc"))"
    [[ "$svc" == hub ]] && print_hub_banner
    return 0
  fi

  local dir log
  case "$svc" in
    hub) dir="$hub_dir" ;;
    web) dir="$web_dir" ;;
  esac
  log="$(logf "$svc")"

  printf '[%s] starting\n' "$svc"

  case "$svc" in
    hub)
      local cmd
      cmd="$(hub_cmd)"
      printf '        %s\n' "$cmd"
      printf '        log: %s\n' "$log"
      ( cd "$dir" && eval "nohup $cmd" >"$log" 2>&1 & echo $! >"$(pidf "$svc")" )
      ;;
    web)
      printf '        bun run dev\n'
      printf '        log: %s\n' "$log"
      ( cd "$dir" && nohup bun run dev >"$log" 2>&1 & echo $! >"$(pidf "$svc")" )
      ;;
  esac

  local port
  port="$(port_for "$svc")"
  for _ in $(seq 1 60); do
    sleep 0.5
    if is_running "$svc"; then
      printf '[%s] up (pid %s, port %s)\n' "$svc" "$(port_pid "$svc")" "$port"
      [[ "$svc" == hub ]] && print_hub_banner
      return 0
    fi
  done

  printf '[%s] FAILED to bind port %s within 30 s — see %s\n' "$svc" "$port" "$log"
  return 1
}

stop_one() {
  local svc="$1"
  local stopped_anything=0

  if [[ -f "$(pidf "$svc")" ]]; then
    local pid
    pid="$(cat "$(pidf "$svc")")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      stopped_anything=1
    fi
    rm -f "$(pidf "$svc")"
  fi

  local port port_pids
  port="$(port_for "$svc")"
  port_pids="$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$port_pids" ]]; then
    echo "$port_pids" | xargs kill 2>/dev/null || true
    stopped_anything=1
  fi

  for _ in $(seq 1 20); do
    sleep 0.25
    is_running "$svc" || {
      [[ $stopped_anything -eq 1 ]] && echo "[$svc] stopped" || echo "[$svc] not running"
      return 0
    }
  done
  lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
  echo "[$svc] stopped (forced)"
}

status_one() {
  if is_running "$1"; then
    echo "[$1] running pid=$(port_pid "$1") port=$(port_for "$1") log=$(logf "$1")"
  else
    echo "[$1] stopped"
  fi
}

resolve_targets() {
  case "${1:-all}" in
    all) echo "hub web" ;;
    hub) echo "hub" ;;
    web) echo "web" ;;
    *) echo "unknown service: $1 (expected hub | web | all)" >&2; exit 1 ;;
  esac
}

cmd="${1:-start}"
target="${2:-all}"

case "$cmd" in
  start)   for s in $(resolve_targets "$target"); do start_one "$s"; done ;;
  stop)    for s in $(resolve_targets "$target"); do stop_one  "$s"; done ;;
  restart) for s in $(resolve_targets "$target"); do stop_one  "$s"; start_one "$s"; done ;;
  status)  for s in $(resolve_targets "$target"); do status_one "$s"; done ;;
  logs)
    case "$target" in
      hub|web) tail -F "$(logf "$target")" ;;
      *) echo "logs requires hub or web (not $target)" >&2; exit 1 ;;
    esac
    ;;
  *)
    sed -n '3,20p' "$0"
    exit 1
    ;;
esac
