#!/usr/bin/env bash
# =============================================================================
# claude-code-buddy statusline integration
#
# Claude Code calls this script every few seconds via the `statusLine.command`
# setting.  The payload arrives on stdin and contains real-time session metrics
# (context window %, cost, token counts, model, code-change lines, etc.).
#
# This minimal script:
#   1. Reads the JSON payload from stdin (can only be read once).
#   2. Forwards it to the claude-code-buddy hub in the background so the
#      dashboard stays up-to-date with official Claude Code metrics.
#   3. Emits a compact status line to stdout for the terminal status bar.
#
# If you already have a custom statusline script, just add the three lines
# marked "BUDDY INTEGRATION" below after your own `INPUT=$(cat)` read.
#
# Configure in ~/.claude/settings.json:
#
#   "statusLine": {
#     "type": "command",
#     "command": "/path/to/claude-code-buddy/hooks/statusline.sh",
#     "padding": 0
#   }
#
# =============================================================================

# ── 1. Read stdin (MUST be first — stdin can only be consumed once) ──────────
INPUT=$(cat)

# ── BUDDY INTEGRATION ────────────────────────────────────────────────────────
# Forward the full payload to the hub in the background.  Non-blocking (&) so
# the terminal status bar renders immediately without waiting for the curl.
echo "$INPUT" | curl -sS --max-time 3 -X POST --data-binary @- \
  http://127.0.0.1:7381/hook >/dev/null 2>&1 &
# ─────────────────────────────────────────────────────────────────────────────

# ── 2. Build a compact status line from the payload ─────────────────────────
# Requires `jq` (brew install jq).  Falls back to an empty line gracefully.
if command -v jq >/dev/null 2>&1; then
  MODEL=$(echo "$INPUT"  | jq -r '.model.display_name // ""')
  PCT=$(echo   "$INPUT"  | jq -r '.context_window.used_percentage // ""')
  COST=$(echo  "$INPUT"  | jq -r '.cost.total_cost_usd // ""')

  PARTS=()
  [ -n "$MODEL" ] && PARTS+=("🤖 $MODEL")
  [ -n "$PCT"   ] && PARTS+=("🧠 ${PCT}%")
  [ -n "$COST"  ] && printf -v FMT_COST '$%.2f' "$COST" 2>/dev/null \
                  && PARTS+=("💰 $FMT_COST")

  # Join with separator
  (IFS=" · "; echo "${PARTS[*]}")
fi
