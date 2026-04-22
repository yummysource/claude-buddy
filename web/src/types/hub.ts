/**
 * @file TypeScript types for the BuddyHub WebSocket heartbeat payload.
 *
 * Every field here is produced by `BuddyHub.build_heartbeat` (server/python/hub/hub.py).
 * The hub emits a FULL snapshot on every state change — clients never merge
 * partial updates, so most fields are optional: present only when the hub has
 * data to report for the current focused session.
 *
 * Keep these types in lockstep with the Python side; a mismatch silently
 * degrades to "missing field" in the UI rather than a runtime error.
 */

/**
 * A single session entry in the sidebar list.
 *
 * Sourced from `BuddyHub._session_rows`. String widths are truncated server-side
 * to keep the heartbeat small and avoid layout thrash on very long names.
 */
export interface HubSession {
  /** 8-char truncated session ID — compact label used in the UI. */
  sid: string;
  /** Full session ID — echoed back as the target of `focus`/`approve`/`deny` commands. */
  full: string;
  /** Project directory name (up to 22 chars). */
  proj: string;
  /** Git branch name (up to 16 chars); empty string when detached or not a repo. */
  branch: string;
  /** Count of dirty (modified + untracked) files in the working tree. */
  dirty: number;
  /** True while Claude is producing a response for this session. */
  running: boolean;
  /** True when the session has emitted a Stop event and is idle, awaiting user input. */
  waiting: boolean;
  /** True for the single session currently displayed in the main panels. */
  focused: boolean;
}

/**
 * A pending PreToolUse approval prompt.
 *
 * Sourced from `BuddyHub._pending_prompt`. The hub blocks the hook call on the
 * Python side until the WebSocket client responds with `approve`/`deny`/`option`.
 * All string fields are pre-truncated for UI display.
 */
export interface HubPrompt {
  /** Unique prompt ID — must be echoed back on every response command. */
  id: string;
  /** Tool name (truncated to 19 chars). */
  tool: string;
  /** One-line summary for the modal body (truncated to 43 chars). */
  hint: string;
  /** Full tool invocation payload pretty-printed for the preview box (truncated to 500 chars). */
  body: string;
  /** Prompt category: `"permission"` for binary approve/deny, or custom kind for option prompts. */
  kind: string;
  /** Optional choice list (up to 4) for multi-choice prompts; dispatch via `sendOption(id, index)`. */
  options?: string[];
  /** 8-char session ID prefix — shown as a badge so the operator knows which session is asking. */
  sid?: string;
  /** Project name (truncated to 23 chars). */
  project?: string;
}

/**
 * Full heartbeat snapshot emitted by BuddyHub on every state change.
 *
 * The payload is always a complete snapshot — the client replaces its entire
 * UI state on each message. Grouped roughly as: liveness marker, headline
 * counters, transcript, approval counters, focused-session detail fields.
 */
export interface HubHeartbeat {
  /** Always `true` — sentinel used by `useHub` to reject any non-heartbeat frame. */
  _live: boolean;

  /** Human-readable status line (approval tool name while a prompt is pending, last transcript line otherwise). */
  msg: string;

  /** Total effective sessions (running + recently-stopped still inside the TTL window). */
  total: number;
  /** Sessions currently executing a response. */
  running: number;
  /** Sessions waiting for the operator to type a reply. */
  waiting: number;

  /**
   * Recent transcript entries as pre-formatted strings (`"HH:MM body"` or
   * `"HH:MM:SS body"`). Order: newest first; see `EventStream` for display order.
   */
  entries: string[];

  /** Cumulative count of PreToolUse approvals issued this session. */
  approvals:  number;
  /** Cumulative count of PreToolUse denials issued this session. */
  denials:    number;
  /** Cumulative count of failed hook invocations (non-zero exit). */
  fail_count: number;

  /** User or operator name associated with the hub owner; surfaced only in debug views. */
  owner?:  string;
  /** Token budget for the context-usage progress bar (denominator; defaults to 200_000 in UI). */
  budget?: number;

  /** Present iff a PreToolUse hook is currently blocking for approval. */
  prompt?: HubPrompt;

  /** Up to 5 sessions, newest-first. Absent when no sessions have connected. */
  sessions?: HubSession[];

  /* ── Focused-session fields (present when a session is selected) ─────── */

  /** Focused session's project directory name. */
  project?:       string;
  /** Focused session's git branch. */
  branch?:        string;
  /** Dirty file count on the focused session. */
  dirty?:         number;
  /** Lines added this session (cumulative across PostToolUse diffs). */
  lines_added?:   number;
  /** Lines removed this session (cumulative across PostToolUse diffs). */
  lines_removed?: number;

  /**
   * Official context-window occupancy as a pre-computed integer percentage
   * (0–100) delivered by Claude Code's `statusline` hook. Use this directly
   * for the Context Usage progress bar when present; fall back to computing
   * `tokens / budget × 100` only when absent (e.g. before the first
   * statusline fires).
   */
  context_pct?:  number;
  /** `input_tokens + cache_tokens` — denominator for the context-usage gauge. */
  tokens?:       number;
  /** Input tokens across the session (excludes cache). */
  input_tokens?:  number;
  /** Output tokens (billed as output) across the session. */
  output_tokens?: number;
  /** Cache-read tokens across the session. */
  cache_tokens?:  number;
  /** `cache_tokens / (input_tokens + cache_tokens) * 100` — cache-hit gauge. */
  cache_pct?:    number;

  /** Per-tool invocation counts for the focused session (e.g. `{Bash: 12, Read: 3}`). */
  tool_counts?: Record<string, number>;
  /**
   * Latest Bash invocation captured by the PostToolUse hook for the focused
   * session. Absent for non-Bash tools or before any Bash call.
   */
  last_cmd?: {
    /** Command string (truncated to 120 chars). */
    cmd:  string;
    /** Stdout output (truncated to 300 chars). */
    out:  string;
    /** Process exit code (`0` for success). */
    code: number;
  };

  /** Session wall-clock duration in seconds (server-side snapshot). */
  duration?:    number;
  /** Session start time formatted as `"HH:MM"` — for display only. */
  started_at?:  string;
  /** Session start as Unix seconds — used by the header's live duration ticker. */
  started_ts?:  number;
  /** Source identifier (e.g. IDE name) — shown under the model in the Model card. */
  source?:      string;

  /** Raw model slug (e.g. `"claude-sonnet-4-6"`); format via `formatModel` before display. */
  model?:    string;
  /** Computed session cost in USD. */
  cost_usd?: number;

  /** Latest assistant message text, for the Latest Response panel. */
  assistant_msg?: string;
  /** Latest user prompt (from the UserPromptSubmit hook), shown as a quote above the assistant reply. */
  human_msg?: string;
}
