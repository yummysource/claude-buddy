# Dashboard Reference

Complete reference for every UI element — what it displays, where the data comes from, and how it is calculated.

[简体中文](DASHBOARD.zh-CN.md) | [繁體中文](DASHBOARD.zh-TW.md)

---

## Data Flow Overview

```
Claude Code hooks                    statusLine.command
    │  POST /hook  (port 7381)           │  stdin payload  (every few seconds)
    ▼                                    ▼
BuddyHub (hub.py) ←──────────────────── statusline.sh forwards to hub
    │  build_heartbeat() on every state change
    ▼
WebSocket (port 7382)
    │  full JSON snapshot per message
    ▼
useHub (React hook)  →  setHeartbeat(JSON.parse(msg))
    │  props passed down
    ▼
UI Components
```

Metrics arrive through two channels: (1) hook POSTs on port 7381, and (2) statusline payloads forwarded by `~/.claude/statusline.sh` every few seconds. Every heartbeat is a **complete snapshot** of the focused session — not a delta. When a new heartbeat arrives, all component state is replaced.

---

## Header

```
CLAUDE BUDDY  ●  STARTED: 15:01 · 14m 50s · 1 SESSION · ACTIVE  ·  main
                                                                 [☀ ☾ 🖥]
```

| Element | hb field | Hub source | Frontend calc | No-data |
|---------|----------|-----------|--------------|---------|
| Connection dot | *(WebSocket state)* | `ws.onopen` / `ws.onclose` | Green pulse = connected; Red = disconnected | Red dot |
| `STARTED: HH:MM` | `started_at` | `datetime.fromtimestamp(_sess_start[sid]).strftime("%H:%M")` | Display as-is | Hidden |
| Live timer | `started_ts` | `_sess_start[sid]` (Unix seconds) | `Date.now()/1000 − started_ts`, formatted by `formatDuration()`: `Xh Ym` / `Xm Ys` / `Xs`, ticked every 1 s, resets when `started_ts` changes | Hidden |
| Session count | `total` | `len(effective)` where `effective = sessions running OR stopped < 1800 s ago` | `{total} SESSION` / `{total} SESSIONS` | — |
| Status badge | `running` | `len(_sess_running)` | `running > 1` → `"{N} ACTIVE"`; `running == 1` → `"ACTIVE"` (green); `running == 0` → `"IDLE"` (muted) | `IDLE` |
| Branch badge | `branch` | `git rev-parse --abbrev-ref HEAD` stored in `_sess_meta[sid]["branch"]` | Shown with GitBranch icon inside a border badge | Hidden |

---

## Sidebar — Sessions List

Each row is one entry from `hb.sessions` (up to 10, newest first).

| Element | Field | Hub source | No-data |
|---------|-------|-----------|---------|
| Project name | `session.proj` | `os.path.basename(git_root)`, truncated to 22 chars | Falls back to `session.sid` (8-char ID prefix) |
| Branch + dirty count | `session.branch`, `session.dirty` | `git rev-parse --abbrev-ref HEAD`; `git status --porcelain` line count | Hidden if empty; `· N~` appended only when `dirty > 0` |
| Status dot | `session.running`, `session.waiting` | `sid in _sess_running`; `sid in _sess_waiting` (true while PreToolUse blocks) | Green pulse = running · Yellow = waiting for approval · Grey = idle |
| Active highlight | `session.focused` | `sid == _resolve_focused()` | — |

**Focus resolution priority** (`_resolve_focused`):
1. User tapped a session (`_focused_sid` in `_sess_total`)
2. Session with an active approval prompt
3. Most recently started running session
4. Most recently active session in `_sess_meta`

Clicking a session row sends `{ cmd: "focus", sid: full_session_id }` over WebSocket; hub sets `_focused_sid` and bumps the heartbeat.

---

## Stat Cards

### Context Usage

```
38%  / 200K
████████░░░░░░░░░░░
```

| Element | hb field | Hub source | Frontend calc | No-data |
|---------|----------|-----------|--------------|---------|
| Percentage | `context_pct`, `tokens`, `budget` | `context_pct`: statusline `context_window.used_percentage` (official pre-calculated integer %, 0–100) | Primary: `context_pct` used directly. Fallback (before first statusline): `clamp(round(tokens / budget × 100), 0, 100)` | `0% / 200K` |
| Progress bar | same | — | `width: {pct}%`, 500 ms transition | Empty bar |
| Colour thresholds | — | — | `< 50%` → primary; `50–69%` → yellow; `≥ 70%` → red + glow | — |
| Warning text | — | — | `≥ 50%` → "Warning: high usage"; `≥ 70%` → "Warning: near capacity" | Hidden |
| Budget label | `budget` | statusline `context_window.context_window_size` (official context window size); fallback: `--budget` CLI flag (default 200 000) | `formatTokens(budget)` → e.g. `200K`, `1.2M` | `200K` |

### Active Model

| Element | hb field | Hub source | No-data |
|---------|----------|-----------|---------|
| Model name | `model` | `model.display_name` from statusline (e.g. `"Sonnet 4.6"`), stored in `_sess_model[sid]`. Fallback: parsed from transcript JSONL before first statusline fires | `"—"` |
| Source label | `source` | `SessionStart` hook `source` field (e.g. `"startup"`, `"ide"`) | `"CLAUDE CODE"` |

### Cache Hit Rate

| Element | hb field | Hub source | Frontend calc | No-data |
|---------|----------|-----------|--------------|---------|
| Percentage | `cache_pct` | `int(cache_tokens × 100 / (input_tokens + cache_tokens))`; 0 if denominator = 0 | `round(cache_pct)` | `0%` |
| Progress bar | same | — | `width: {pct}%` | Empty bar |

**Token accounting** — The primary source for all token counts is the statusline
payload, which Claude Code pre-calculates and delivers every few seconds:

- `input_tokens` = `context_window.total_input_tokens` from statusline (cumulative session total).
- `output_tokens` = `context_window.total_output_tokens` from statusline (cumulative session total).
- `cache_tokens` = `context_window.current_usage.cache_read_input_tokens` from statusline (latest call — reflects the current prompt size living in cache, NOT summed across calls).

Fallback (before the first statusline payload arrives): transcript JSONL is
scanned only to extract `model` and `assistant_msg`; token fields are not
populated from the transcript.

### Session Cost

| Element | hb field | Hub source | Frontend calc | No-data |
|---------|----------|-----------|--------------|---------|
| Cost | `cost_usd` | `cost.total_cost_usd` from statusline — Claude Code's official cumulative session cost in USD, no estimation needed | `$${cost.toFixed(2)}` | `$0.00` |
| Token count | `tokens` | `input_tokens + cache_tokens` | `formatTokens(tokens)` → e.g. `76K` | `"No data"` |

---

## Metric Panels

### Token Distribution

Three horizontal bars showing breakdown of token types for the focused session.

| Bar | hb field | Hub source | Bar width |
|-----|----------|-----------|-----------|
| INPUT | `input_tokens` | `context_window.total_input_tokens` from statusline (cumulative session total) | `inp / total × 100%` |
| OUTPUT | `output_tokens` | `context_window.total_output_tokens` from statusline (cumulative session total) | `out / total × 100%` |
| CACHE | `cache_tokens` | `context_window.current_usage.cache_read_input_tokens` from statusline (latest call, not summed — see accounting note above) | `cache / total × 100%` |

`total = inp + out + cache` (minimum 1 to prevent division by zero).  
Values formatted with `formatTokens()`: `< 1 000` → raw; `≥ 1 000` → `NNK`; `≥ 1 000 000` → `N.NM`.

No-data: all three fields absent → all bars empty, values show `0`.

> **Why INPUT can still look small vs CACHE** — a long-running session with
> prompt caching may show `INPUT = 40K` against `CACHE = 180K`. That is
> correct: the cache bar is the current prompt size, while the input bar is
> the cumulative "new" content the model has seen since the session started.

### Operator Approvals

Counts are **per focused session**, reset when switching to a different session.

| Box | hb field | Hub source | No-data |
|-----|----------|-----------|---------|
| APPROVED | `approvals` | `_sess_approvals[sid]`, incremented each time user clicks Approve in the modal | `0` |
| DENIED | `denials` | `_sess_denials[sid]`, incremented each time user clicks Deny or presses Escape | `0` |
| FAILED | `fail_count` | `_sess_fail_count[sid]`, incremented on every `PostToolUseFailure` hook | `0` |

### Code Changes

| Element | hb field | Hub source | Frontend calc | No-data |
|---------|----------|-----------|--------------|---------|
| `+N` insertions | `lines_added` | `cost.total_lines_added` from statusline — Claude Code's official cumulative line insertions for this session | `+${added.toLocaleString()}` | `—` |
| `-N` deletions | `lines_removed` | `cost.total_lines_removed` from statusline — Claude Code's official cumulative line deletions for this session | `-${removed.toLocaleString()}` | `—` |
| Progress bars | same | — | `peak = max(added, removed, 1)`; insertion bar = `added/peak × 100%`; deletion bar = `removed/peak × 100%`. The larger value fills 100%, the other scales proportionally. | Both bars empty |

> `null` (field absent) and `0` (zero changes) are handled differently: `null` shows `—`; `0` shows `+0` / `-0`.

> `_refresh_git` is still run, but only to obtain `branch` and `dirty` count — statusline does not provide these fields.

**Tool call counts** (below the bars):

| Element | hb field | Hub source |
|---------|----------|-----------|
| Tool name + count | `tool_counts` | `_tool_counts[sid][tool_name]++` on every `PostToolUse` hook |

Display order: `Bash → Edit → Write → Read → Glob → Grep → WebFetch → WebSearch → Agent`, then any additional tools alphabetically. All tools shown (no limit). Hidden entirely when `tool_counts` is absent or empty.

---

## Latest Response

Terminal-style panel for the focused session's last exchange.

```
┌─────────────────────────────────────────┐
│ ● ● ●  claude-code-buddy (main)         │
├─────────────────────────────────────────┤
│  YOU:                                   │
│  ▎ user question here...               │
│                                         │
│  sonnet 4.6:~$                          │
│                                         │
│  assistant reply here...                │
└─────────────────────────────────────────┘
```

| Element | hb field | Hub source | No-data |
|---------|----------|-----------|---------|
| Title bar path | `project`, `branch` | `os.path.basename(git_root)` + `git rev-parse --abbrev-ref HEAD` | `"claude-code"` |
| Session time | `started_at` | `datetime.fromtimestamp(_sess_start[sid]).strftime("%H:%M")` | Hidden |
| Prompt line | `model` | `model.display_name` → lowercase + `:~$` | `claude:~$` |
| User question label | *(layout)* | `"YOU:"` label rendered above the quoted prompt | — |
| User question | `human_msg` | `_on_user_prompt` hook: `prompt` field, newlines preserved, smart Markdown truncation (min 300 chars), stored in `_sess_human[sid]`; rendered as Markdown | Hidden (not rendered) |
| Assistant reply | `assistant_msg` | Primary: `Stop` hook `last_assistant_message`, Markdown-aware truncation (min 500 chars, max 1500). Fallback: transcript JSONL last `role=assistant` message. Stored in `_sess_assistant[sid]`; rendered as GitHub-Flavoured Markdown | `"Waiting for response…"` |

Both `assistant_msg` and `human_msg` are **per-session only** — switching to a session with no history clears both fields.

---

## Event Stream

Chronological timeline of hook events for the focused session.

```
Event Stream
│
●  15:03  Bash done
│
●  15:02  > fix the auth bug
│
●  15:01  session: claude-code-buddy
```

| Element | hb field | Hub source |
|---------|----------|-----------|
| Event entries | `entries` | `_sess_transcript[sid]` (per-session `deque(maxlen=20)`), each entry `"HH:MM {body[:80]}"` |
| Display order | — | Newest first; up to 10 entries shown; no count badge |

**What each hook writes to the transcript:**

| Hook | Entry text |
|------|-----------|
| `SessionStart` | `session: {project}` or `session started` |
| `Stop` | `session done` |
| `UserPromptSubmit` | `> {prompt[:60]}` |
| `PreToolUse` (bypass) | `{tool} (bypass)` |
| `PreToolUse` approved | `{tool} allow` |
| `PreToolUse` denied | `{tool} deny` |
| `PreToolUse` timeout (30 s) | `{tool} timeout` |
| `PreToolUse` option selected | `{tool} → {label[:30]}` |
| `PostToolUse` | `{tool} done` |
| `PostToolUseFailure` | `{tool} FAIL: {error[:60]}` |
| `Notification` | `[notify] {message[:60]}` |

**Colour coding** (by body content):

| Colour | Condition |
|--------|-----------|
| Red | contains `error`, `fail`, or `denied` |
| Primary (gold) | contains `warn` or `approv` / `success` / `passed` |
| Green | contains `approv`, `success`, `passed` |
| Primary/60 | contains `tool`, `bash`, or `read` |
| Grey | everything else |

Entries are per-session — switching sessions shows only that session's own events.

---

## Approval Modal

Full-screen overlay shown whenever a `PreToolUse` hook is blocking Claude Code, waiting for a decision.

```
┌─────────────────────────────────────────┐
│  Operator Approval Required             │
│  BASH                                   │
│  [abc12345]  my-project                 │
│                                         │
│  run the test suite                     │
│  ┌───────────────────────────────────┐  │
│  │ npm test                          │  │
│  └───────────────────────────────────┘  │
│                                         │
│  [✓ Approve]          [✗ Deny]          │
└─────────────────────────────────────────┘
```

| Element | hb field | Hub source |
|---------|----------|-----------|
| Tool name | `prompt.tool` | `tool_name` from hook payload, truncated to 19 chars |
| Hint text | `prompt.hint` | `_hint()`: `Bash` → `command`; `Read/Edit/Write` → `file_path`; `WebFetch` → `url`; `WebSearch` → `query`. Truncated to 43 chars |
| Body (code block) | `prompt.body` | `_body()`: tool-specific detail — Bash shows description + command; Edit shows old/new text diff; Write shows path + first 320 chars of content. Truncated to 500 chars |
| Session badge | `prompt.sid` | `session_id[:8]` |
| Project badge | `prompt.project` | `_sess_meta[sid]["project"]`, truncated to 23 chars |
| Options (AskUserQuestion) | `prompt.options` | Choice labels from the question payload, up to 4 |

**Decision flow:**

| Action | WebSocket command | Hub response |
|--------|------------------|-------------|
| Click Approve | `{ cmd: "approve", id }` | `permissionDecision: "allow"` |
| Click Deny / Escape | `{ cmd: "deny", id }` | `permissionDecision: "deny"` |
| Click option button | `{ cmd: "option", id, index }` | `permissionDecision: "deny"` with the chosen label in reason (Claude reads the reason to get the answer) |
| No action for 30 s | *(timeout)* | Empty response — Claude Code uses its default behaviour |

Multiple concurrent approval requests are queued; the modal advances to the next one automatically after each decision.

---

## Mobile Bottom Navigation

Visible on screens narrower than `md` (768 px). Single **Sessions** button that toggles a left-side drawer over the main content. The drawer contains the same session list as the desktop sidebar; tapping a session row focuses it and closes the drawer. Tapping the backdrop also closes the drawer.
