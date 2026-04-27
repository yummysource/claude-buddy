#!/usr/bin/env bash
# Forward a Claude Code hook payload to the buddy hub. Always exits 0 with
# `{}` on stdout so Claude Code keeps working when the hub is offline.
#
# Why drain stdin first: if curl exits early (e.g. connection refused), the
# parent's stdin write gets SIGPIPE and Claude Code reports the hook as
# failed. Buffering the payload before invoking curl avoids that.
#
# Usage: post-hook.sh [timeout_seconds]
#   timeout_seconds defaults to 3; PreToolUse should pass 40.

timeout="${1:-3}"
payload=$(cat)

curl -sS --max-time "$timeout" \
     -X POST --data-binary "$payload" \
     http://127.0.0.1:7381/hook >/dev/null 2>&1 || true

printf '{}'
