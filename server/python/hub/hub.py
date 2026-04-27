"""
BuddyHub — core state machine.

Responsibilities:
- Receive and dispatch Claude Code hook events
- Maintain session state (running / idle / TTL-expired)
- Track token usage, cost estimates, and tool call counts
- Maintain per-session git state (branch / dirty files / cumulative line diff)
- Build heartbeat snapshots pushed to WebSocket clients and hardware device

Thread safety: all mutable state is guarded by self._lock.
Heartbeat delivery: callers register a broadcast callback via set_broadcast().
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from datetime import datetime
from typing import Any, Callable

from .transports import Transport


def _log(*a):
    print(*a, file=sys.stderr, flush=True)


class BuddyHub:
    """Core state machine for the hub.

    Receives Claude Code hooks (HTTP → ``handle_hook``), maintains per-session
    state (tokens, cost, tool counts, git snapshot, transcript excerpts), and
    produces heartbeat snapshots that are broadcast to WebSocket clients and
    the optional hardware transport.

    Concurrency model:
        All mutable state lives in dicts/sets keyed by ``session_id``; they are
        guarded by ``self._lock``. Subprocess calls (``git``), file reads
        (transcripts) and ``transport.write`` are performed *outside* the lock
        to keep hold times short — critical because PreToolUse handlers may
        block for up to 30 s waiting for a user decision.

    The class is instantiated once per process by ``__main__.main``.
    """

    _GIT_TTL     = 10    # seconds between git-status refreshes per session
    _SESS_EXPIRY = 1800  # seconds after Stop before a session is dropped from display

    # Maps tool name → primary input field used as the one-line hint
    _HINT_FIELDS: dict[str, str] = {
        "Bash": "command", "Edit": "file_path", "MultiEdit": "file_path",
        "Write": "file_path", "Read": "file_path", "NotebookEdit": "notebook_path",
        "WebFetch": "url", "WebSearch": "query",
        "Glob": "pattern", "Grep": "pattern",
    }

    def __init__(self, *, transport: Transport, ws_port: int, http_port: int,
                 budget: int, owner: str):
        """Wire the hub up but do not start any threads — see ``start()``.

        Args:
            transport: Hardware transport (serial / BLE / null); outbound JSON
                frames are written through it in addition to WebSocket clients.
            ws_port: WebSocket port number, reported in heartbeat snapshots so
                clients can display it. The actual socket is owned by
                ``HubServer``.
            http_port: HTTP hook port number, recorded for the same reason.
            budget: Context-window token budget used to render the progress
                bar. ``0`` hides it.
            owner: Human-readable owner label shown in the dashboard header.
        """
        self.transport  = transport
        self.ws_port    = ws_port
        self.http_port  = http_port
        self.budget     = budget
        self.owner      = owner

        # Session state — every dict/set below is guarded by _lock.
        # What _lock does NOT cover: transport.write (can block on serial/BLE),
        # git subprocess calls, transcript file reads, and the WebSocket
        # asyncio loop — those must happen outside the critical section so
        # PreToolUse waits (up to 30 s) do not stall unrelated hooks.
        self._lock            = threading.Lock()
        self._sess_running    : set[str]                   = set()
        self._sess_total      : set[str]                   = set()
        self._sess_waiting    : set[str]                   = set()
        self._sess_meta       : dict[str, dict[str, Any]]  = {}  # sid → git/project metadata
        self._sess_assistant  : dict[str, str]             = {}  # sid → latest assistant text
        self._sess_human      : dict[str, str]             = {}  # sid → latest user prompt text
        self._sess_transcript : dict[str, deque[str]]      = {}  # sid → per-session event log
        self._sess_approvals  : dict[str, int]             = {}  # sid → approval count
        self._sess_denials    : dict[str, int]             = {}  # sid → denial count
        self._sess_fail_count : dict[str, int]             = {}  # sid → tool failure count
        self._sess_model      : dict[str, str]             = {}  # sid → short model name
        self._sess_model_full : dict[str, str]             = {}  # sid → full model ID
        self._sess_start      : dict[str, float]           = {}  # sid → start timestamp
        self._sess_stop_time  : dict[str, float]           = {}  # sid → last Stop timestamp (for TTL)
        self._sess_source     : dict[str, str]             = {}  # sid → "startup"|"resume"|…

        # Token + cost tracking (per-session).
        # Primary source: the `statusline` hook payload (Claude Code-computed,
        # authoritative). Fallback for sessions that haven't received a statusline
        # yet: transcript JSONL parsing (see _parse_transcript).
        #
        #   _input_tokens     — context_window.total_input_tokens (cumulative)
        #   _output_tokens    — context_window.total_output_tokens (cumulative)
        #   _cache_tokens     — current_usage.cache_read_input_tokens (latest call)
        #   _sess_context_pct — context_window.used_percentage  (official %)
        #   _sess_context_sz  — context_window.context_window_size
        #   _sess_cost        — cost.total_cost_usd (official session cost)
        #   _sess_lines_added / _sess_lines_removed — cost.total_lines_* (official)
        self._input_tokens      : dict[str, int]   = {}
        self._output_tokens     : dict[str, int]   = {}
        self._cache_tokens      : dict[str, int]   = {}
        self._sess_context_pct  : dict[str, int]   = {}
        self._sess_context_sz   : dict[str, int]   = {}
        self._sess_cost         : dict[str, float] = {}
        self._sess_lines_added  : dict[str, int]   = {}
        self._sess_lines_removed: dict[str, int]   = {}

        # Tool and action tracking
        self._tool_counts     : dict[str, dict[str, int]] = {}  # sid → {tool_name: count}
        self._last_cmd        : dict[str, dict[str, Any]] = {}  # sid → {cmd, out, code}
        self._fail_count      : int = 0

        # Misc state
        self._transcript      : deque[str] = deque(maxlen=8)
        self._assistant_msg   = ""
        self._human_msg       = ""
        self._model_name      = ""
        self._active_prompt   : dict | None = None
        self._pending_prompts : dict[str, dict] = {}  # pid → prompt dict (awaiting decision)
        self._pending         : dict[str, dict] = {}  # pid → {event, decision}
        self._focused_sid     : str | None = None
        self._approve_count   = 0
        self._deny_count      = 0

        # Heartbeat delivery
        self._bump            = threading.Event()
        self._broadcast_fn    : Callable[[dict], None] | None = None

        # Hook dispatch table — built once to avoid repeated dict construction per request
        self._handlers: dict[str, Callable[[dict], dict]] = {
            "SessionStart":       self._on_session_start,
            "Stop":               self._on_session_stop,
            "UserPromptSubmit":   self._on_user_prompt,
            "PreToolUse":         self._on_pretool,
            "PostToolUse":        self._on_posttool,
            "PostToolUseFailure": self._on_posttool_fail,
            "Notification":       self._on_notification,
            # statusline fires every few seconds with authoritative metrics
            # (context window %, cost, token counts, lines changed, model).
            "statusline":         self._on_statusline,
        }

        # Serial/BLE RX buffer
        self._rx_buf = bytearray()

    # ── Public API ────────────────────────────────────────────────────────

    def set_broadcast(self, fn: Callable[[dict], None]) -> None:
        """Register a callback invoked with each heartbeat snapshot (called from heartbeat thread)."""
        self._broadcast_fn = fn

    def notify_state_change(self) -> None:
        """Signal that state has changed and a heartbeat should be sent."""
        self._bump.set()

    def send_greeting(self, ts: int, tz_offset: int) -> None:
        """Send the initial device handshake frames (owner, time, heartbeat) on transport connect."""
        if self.owner:
            self._send({"cmd": "owner", "name": self.owner})
        self._send({"time": [ts, tz_offset]})
        self._send(self.build_heartbeat())

    # ── Wire I/O ──────────────────────────────────────────────────────────

    def _send(self, obj: dict) -> None:
        """Serialize obj as compact JSON and write to the transport."""
        data = (json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
        self.transport.write(data)

    def on_rx_byte(self, b: int) -> None:
        """Called by the transport for each incoming byte; assembles newline-delimited JSON."""
        if b in (0x0A, 0x0D):
            if self._rx_buf:
                self._on_rx_line(bytes(self._rx_buf).decode("utf-8", errors="replace"))
            self._rx_buf = bytearray()
        elif len(self._rx_buf) < 4096:
            self._rx_buf.append(b)

    def _on_rx_line(self, line: str) -> None:
        """Parse one newline-delimited JSON frame from the hardware transport.

        Non-JSON lines (debug prints from the device firmware) are logged and
        dropped rather than raising — the transport is untrusted input.
        """
        _log(f"[dev<] {line}")
        if not line.startswith("{"):
            return
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            return
        self._dispatch_command(obj)

    def dispatch_ws_command(self, obj: dict) -> None:
        """Public entry for commands arriving via the WebSocket server.

        Hardware transport and WebSocket share the same command vocabulary, so
        both funnel into ``_dispatch_command``.
        """
        self._dispatch_command(obj)

    def _dispatch_command(self, obj: dict) -> None:
        """
        Handle approve/deny/option/focus commands from the web UI or hardware device.

        WebSocket protocol (frontend → hub):
          { cmd: "approve",  id: "<pid>" }
          { cmd: "deny",     id: "<pid>" }
          { cmd: "option",   id: "<pid>", index: N }
          { cmd: "focus",    sid: "<full_session_id>" }
          { cmd: "ping" }                                                       # keepalive, ignored
          { cmd: "permission", id: "<pid>", decision: "once"|"deny"|"option:N" }  # legacy

        Decision commands (approve/deny/option/permission) read AND mutate
        self._pending concurrently with _on_pretool's finally block which pops
        entries. The lookup + mutation must happen under self._lock so a client
        cannot set "decision" on a holder that is simultaneously being removed
        — that would leave event.set() orphaned and the PreToolUse wait
        timing out instead of honouring the click.
        """
        cmd = obj.get("cmd")

        if cmd == "ping":
            return

        if cmd in ("approve", "deny", "option", "permission"):
            pid = obj.get("id")
            with self._lock:
                h = self._pending.get(pid)
                if not h:
                    return
                if cmd == "approve":
                    h["decision"] = "once"
                elif cmd == "deny":
                    h["decision"] = "deny"
                elif cmd == "option":
                    h["decision"] = f"option:{obj.get('index', 0)}"
                else:  # legacy "permission"
                    h["decision"] = obj.get("decision")
                ev = h["event"]
            ev.set()
            return

        if cmd in ("focus", "focus_session"):
            with self._lock:
                self._focused_sid = obj.get("sid") or None
            self._bump.set()

    # ── Heartbeat ─────────────────────────────────────────────────────────

    def build_heartbeat(self) -> dict:
        """Build the full state snapshot pushed to every client.

        The snapshot is always a *complete* replacement (never a diff) so
        clients can drop and re-render the whole UI on each frame. This keeps
        the wire protocol robust against dropped or out-of-order frames at the
        cost of a slightly larger payload.

        Returns:
            Dict ready to be JSON-serialised. Fields are optional so late-
            joining clients still get a usable snapshot; the one guaranteed
            key is ``_live: True``.
        """
        with self._lock:
            # Effective sessions: running OR stopped within SESS_EXPIRY window.
            now = time.time()
            effective = {
                s for s in self._sess_total
                if s in self._sess_running
                or now - self._sess_stop_time.get(s, now) < self._SESS_EXPIRY
            }

            # msg and entries will be overridden with per-session values after sid resolves.
            hb: dict = {
                "_live":      True,
                "msg":        "idle",
                "total":      len(effective),
                "running":    len(self._sess_running),
                "waiting":    len(self._sess_waiting),
                "entries":    [],
                "approvals":  0,
                "denials":    0,
                "fail_count": 0,
            }
            if self.owner:      hb["owner"]  = self.owner
            if self.budget > 0: hb["budget"] = self.budget

            # Approval card payload
            if self._active_prompt:
                p  = self._active_prompt
                ph = {
                    "id":   p["id"],
                    "tool": p["tool"][:19],
                    "hint": p["hint"][:43],
                    "body": p["body"][:500],
                    "kind": p.get("kind", "permission"),
                }
                opts = p.get("option_labels") or []
                if opts:
                    ph["options"] = opts[:4]
                sid = p.get("session_id", "")
                if sid:
                    ph["sid"]     = sid[:8]
                    ph["project"] = (self._sess_meta.get(sid) or {}).get("project", "")[:23]
                hb["prompt"] = ph

            # Resolve focused session once for consistent list highlight + detail panel.
            sid = self._resolve_focused()

            # Per-session event log, counters, and status message.
            sess_tr = self._sess_transcript.get(sid) if sid else None
            hb["entries"]    = list(sess_tr) if sess_tr else []
            hb["approvals"]  = self._sess_approvals.get(sid,  0) if sid else 0
            hb["denials"]    = self._sess_denials.get(sid,    0) if sid else 0
            hb["fail_count"] = self._sess_fail_count.get(sid, 0) if sid else 0
            if self._active_prompt:
                hb["msg"] = f"approve: {self._active_prompt['tool']}"
            elif sess_tr:
                hb["msg"] = sess_tr[0][6:]  # strip "HH:MM " prefix
            elif sid:
                hb["msg"] = "idle"

            sessions = [
                {
                    "sid":     s[:8],
                    "full":    s,
                    "proj":    (m.get("project") or "")[:22],
                    "branch":  (m.get("branch")  or "")[:16],
                    "dirty":   m.get("dirty", 0),
                    "running": s in self._sess_running,
                    "waiting": s in self._sess_waiting,
                    "focused": s == sid,
                }
                for s in sorted(effective, key=lambda s: self._sess_start.get(s, 0), reverse=True)[:10]
                for m in [self._sess_meta.get(s) or {}]
            ]
            if sessions:
                hb["sessions"] = sessions

            if sid:
                m = self._sess_meta.get(sid) or {}
                hb.update(
                    project = m.get("project", ""),
                    branch  = m.get("branch",  ""),
                    dirty   = m.get("dirty",   0),
                )

                # Code-change lines: prefer the official statusline values (most
                # accurate), fall back to git diff computed by _refresh_git.
                lines_added   = self._sess_lines_added.get(sid)
                lines_removed = self._sess_lines_removed.get(sid)
                if lines_added is None:
                    lines_added   = m.get("lines_added")
                    lines_removed = m.get("lines_removed")
                if lines_added is not None:
                    hb["lines_added"]   = lines_added
                    hb["lines_removed"] = lines_removed or 0

                inp   = self._input_tokens.get(sid, 0)
                out   = self._output_tokens.get(sid, 0)
                cache = self._cache_tokens.get(sid, 0)
                hb["input_tokens"]  = inp
                hb["output_tokens"] = out
                hb["cache_tokens"]  = cache
                denom = inp + cache
                hb["cache_pct"]     = int(cache * 100 / denom) if denom > 0 else 0

                # Context Usage: official percentage + window size from statusline.
                # `tokens` is the raw count for the Session Cost token label.
                ctx_pct = self._sess_context_pct.get(sid)
                ctx_sz  = self._sess_context_sz.get(sid, self.budget)
                if ctx_pct is not None:
                    hb["context_pct"] = ctx_pct   # 0-100, official
                hb["budget"]  = ctx_sz or self.budget
                hb["tokens"]  = int(ctx_pct * ctx_sz / 100) if ctx_pct is not None else inp + cache

                # Official session cost from statusline — no pricing-table estimate needed.
                official_cost = self._sess_cost.get(sid)
                if official_cost is not None:
                    hb["cost_usd"] = round(official_cost, 6)

                tc = self._tool_counts.get(sid, {})
                if tc:
                    hb["tool_counts"] = dict(tc)

                lc = self._last_cmd.get(sid)
                if lc:
                    hb["last_cmd"] = lc

                start = self._sess_start.get(sid)
                if start:
                    hb["started_ts"] = start
                    hb["duration"]   = int(time.time() - start)
                    hb["started_at"] = datetime.fromtimestamp(start).strftime("%H:%M")

                src = self._sess_source.get(sid, "")
                if src:
                    hb["source"] = src

            model = self._sess_model.get(sid) if sid else self._model_name
            if model:
                hb["model"] = model

            amsg = self._sess_assistant.get(sid) if sid else None
            if amsg:
                hb["assistant_msg"] = amsg

            hmsg = self._sess_human.get(sid) if sid else None
            if hmsg:
                hb["human_msg"] = hmsg

        return hb

    def _resolve_focused(self) -> str | None:
        """Pick the session whose details populate the main panel.

        Priority order (first match wins):
            1. Explicit user tap (``_focused_sid``) if it still refers to a
               known session — preserved even for stopped sessions within the
               TTL window so a pinned view does not jump away on Stop.
            2. The session that owns the currently active approval prompt —
               prevents the dashboard from focusing elsewhere while the user
               is about to click approve/deny.
            3. The newest running session by ``_sess_start``.
            4. The most recently git-refreshed session in ``_sess_meta``.

        Caller must already hold ``self._lock``.
        """
        # Respect manual selection for any known session (running or stopped).
        if self._focused_sid and self._focused_sid in self._sess_total:
            return self._focused_sid
        if self._active_prompt and self._active_prompt.get("session_id"):
            return self._active_prompt["session_id"]
        if self._sess_running:
            return max(self._sess_running, key=lambda s: self._sess_start.get(s, 0))
        if self._sess_meta:
            return max(self._sess_meta, key=lambda s: self._sess_meta[s].get("checked_at", 0))
        return None

    _PURGE_INTERVAL = 60  # seconds between sweeps for expired-session state

    def _purge_expired_sessions(self) -> None:
        """Drop per-session state once a session has been stopped for ``_SESS_EXPIRY`` seconds.

        Every ``_sess_*`` / token / tool-count dict must be pruned in lockstep
        — roughly 19 keyed containers in total — otherwise we would leak rows
        that the heartbeat never surfaces. On a weeks-long dev machine this
        would silently accumulate thousands of dead entries.

        Running sessions and sessions still within the TTL window are always
        preserved. ``_focused_sid`` is cleared if it referred to an evicted
        session so the UI falls back through ``_resolve_focused``.
        """
        now = time.time()
        with self._lock:
            expired = [
                sid for sid in self._sess_total
                if sid not in self._sess_running
                and now - self._sess_stop_time.get(sid, now) >= self._SESS_EXPIRY
            ]
            for sid in expired:
                self._sess_total.discard(sid)
                self._sess_waiting.discard(sid)
                self._sess_meta.pop(sid, None)
                self._sess_assistant.pop(sid, None)
                self._sess_human.pop(sid, None)
                self._sess_transcript.pop(sid, None)
                self._sess_approvals.pop(sid, None)
                self._sess_denials.pop(sid, None)
                self._sess_fail_count.pop(sid, None)
                self._sess_model.pop(sid, None)
                self._sess_model_full.pop(sid, None)
                self._sess_start.pop(sid, None)
                self._sess_stop_time.pop(sid, None)
                self._sess_source.pop(sid, None)
                self._input_tokens.pop(sid, None)
                self._output_tokens.pop(sid, None)
                self._cache_tokens.pop(sid, None)
                self._sess_context_pct.pop(sid, None)
                self._sess_context_sz.pop(sid, None)
                self._sess_cost.pop(sid, None)
                self._sess_lines_added.pop(sid, None)
                self._sess_lines_removed.pop(sid, None)
                self._tool_counts.pop(sid, None)
                self._last_cmd.pop(sid, None)
                if self._focused_sid == sid:
                    self._focused_sid = None
        if expired:
            _log(f"[purge] dropped {len(expired)} expired session(s)")

    def _heartbeat_loop(self) -> None:
        """Rate-limited heartbeat: fire on state change or every 10 s as keepalive."""
        MIN_INTERVAL = 1.0
        last = 0.0
        last_purge = time.time()
        while True:
            self._bump.wait(timeout=10)
            self._bump.clear()
            now = time.time()
            if now - last_purge >= self._PURGE_INTERVAL:
                self._purge_expired_sessions()
                last_purge = now
            since = now - last
            if since < MIN_INTERVAL:
                time.sleep(MIN_INTERVAL - since)
            hb = self.build_heartbeat()
            self._send(hb)
            fn = self._broadcast_fn
            if fn:
                fn(hb)
            last = time.time()

    # ── Git helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _git(cwd: str, *args) -> str:
        """Run ``git <args>`` in ``cwd`` and return stripped stdout, or ``""`` on any failure.

        Arguments are passed as a tuple (``("git", *args)``) rather than a
        shell string to eliminate shell-injection risk from user-controlled
        cwd/branch values. A 2-second timeout bounds the hook response time
        even when the repo is in a bad state (e.g. filesystem lock).
        """
        try:
            r = subprocess.run(("git", *args), cwd=cwd, capture_output=True,
                               text=True, timeout=2, check=False)
            return r.stdout.strip() if r.returncode == 0 else ""
        except Exception:
            return ""

    def _refresh_git(self, sid: str, cwd: str) -> None:
        """Refresh the cached git snapshot for ``sid`` if its TTL has expired.

        Since the ``statusline`` hook delivers official ``cost.total_lines_added``
        and ``cost.total_lines_removed`` directly, this method no longer runs
        ``git diff``. It only fetches the three fields that statusline omits:
        project name, branch, and dirty-file count.

        Uses a lock-fast / release-slow pattern: the TTL check happens inside
        ``self._lock`` (cheap dict lookup), then the lock is released for the
        git subprocess calls (each up to 2 s), and finally reacquired to write
        the result. This keeps critical-section hold times under a millisecond
        even while git is slow.
        """
        if not cwd or not os.path.isdir(cwd):
            return

        # Check TTL under lock, then release before slow subprocess calls.
        with self._lock:
            meta = self._sess_meta.get(sid) or {}
            if meta.get("cwd") == cwd and time.time() - meta.get("checked_at", 0) < self._GIT_TTL:
                return

        # Lines-added/removed are now sourced from the `statusline` hook
        # (cost.total_lines_added/removed), which is more accurate than our
        # own git diff. We only run git here for branch and dirty-file count,
        # which statusline does not provide.
        root   = self._git(cwd, "rev-parse", "--show-toplevel") or cwd
        branch = self._git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
        dirty  = sum(1 for ln in self._git(cwd, "status", "--porcelain").splitlines() if ln.strip())

        with self._lock:
            self._sess_meta[sid] = {
                "cwd":       cwd,
                "project":   os.path.basename(root.rstrip("/"))[:39] or "",
                "branch":    branch[:39],
                "dirty":     dirty,
                "checked_at": time.time(),
            }

    # ── Transcript parsing ────────────────────────────────────────────────

    @staticmethod
    def _transcript_start_time(path: str) -> float | None:
        """Read the first JSONL entry and return session start as epoch seconds (field is ms)."""
        if not path or not os.path.exists(path):
            return None
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line or not line.startswith("{"):
                        continue
                    try:
                        obj = json.loads(line)
                        ts  = obj.get("timestamp")
                        # Claude Code stores timestamps as Unix milliseconds (>10^12).
                        if isinstance(ts, (int, float)) and ts > 1_000_000_000_000:
                            return ts / 1000.0
                    except json.JSONDecodeError:
                        continue
        except Exception:
            pass
        return None

    @staticmethod
    def _tail_lines(path: str, n: int = 131072) -> list[str]:
        """Return the last ``n`` bytes of ``path`` as decoded lines.

        The transcript JSONL can grow to many MB over a long session; reading
        the tail keeps parse time O(1) w.r.t. session age. The leading
        partial line (if any) is usually invalid JSON and will be skipped
        downstream by ``_parse_transcript``.
        """
        if not path or not os.path.exists(path):
            return []
        try:
            sz = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(max(0, sz - n))
                return f.read().decode("utf-8", errors="replace").splitlines()
        except Exception:
            return []

    def _parse_transcript(self, path: str) -> tuple[str, str]:
        """
        Extract the model id and latest assistant message text from the transcript.

        Token metrics are now sourced from the ``statusline`` hook (which Claude
        Code pre-computes and delivers in real time), so we no longer need to
        sum usage blocks here. This method is used only as a fallback to
        recover the model name and the visible assistant text before the first
        statusline fires.

        Returns:
            (model_id, assistant_text) — both empty strings when nothing is found.
        """
        model = assistant = ""
        if not path or not os.path.exists(path):
            return model, assistant
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
        except OSError:
            return model, assistant

        for line in reversed(lines):
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = obj.get("message", obj)
            if not isinstance(msg, dict) or msg.get("role") != "assistant":
                continue
            if not model:
                m = msg.get("model")
                if isinstance(m, str) and m:
                    model = m
            if not assistant:
                content = msg.get("content")
                text = content if isinstance(content, str) else next(
                    (b.get("text", "") for b in (content or [])
                     if isinstance(b, dict) and b.get("type") == "text"), "")
                text = text.strip()
                if text:
                    assistant = BuddyHub._truncate_markdown(text)
            if model and assistant:
                break

        return model, assistant

    @staticmethod
    def _truncate_markdown(text: str, min_len: int = 500, max_len: int = 1500) -> str:
        """Truncate Markdown text at a safe boundary after ``min_len`` characters.

        Strategy:
        1. If text ≤ min_len, return it unchanged.
        2. From min_len, find the next blank line (paragraph boundary) as the
           cut point.  Falls back to the next newline, then to min_len itself.
        3. If the result contains an odd number of triple-backtick fences
           (i.e. a code block is unclosed), extend to include the next closing
           fence so the Markdown renderer sees balanced delimiters.
        4. Hard cap at max_len regardless.

        Args:
            text:    Raw Markdown string (newlines preserved).
            min_len: Minimum number of characters to include.
            max_len: Absolute upper limit; truncated text never exceeds this.

        Returns:
            Truncated string, guaranteed not to leave a triple-backtick fence open.
        """
        if len(text) <= min_len:
            return text

        bounded = text[:max_len]

        # Prefer cutting at the next blank line after min_len.
        cut = bounded.find("\n\n", min_len)
        if cut == -1:
            cut = bounded.find("\n", min_len)
        if cut == -1:
            cut = len(bounded)

        result = bounded[:cut].rstrip()

        # Ensure triple-backtick fences are balanced.
        if result.count("```") % 2 == 1:
            close = text.find("```", cut)
            if 0 < close < max_len:
                # Include the closing fence line.
                eol = text.find("\n", close + 3)
                result = text[: eol if eol != -1 else close + 3].rstrip()
            else:
                # Closing fence is beyond max_len or absent; append one so the
                # renderer does not treat the rest of the page as a code block.
                result += "\n```"

        return result

    @staticmethod
    def _short_model(full: str) -> str:
        """Convert a full model ID to a short display name, e.g. 'claude-sonnet-4-5' → 'Sonnet 4.5'.

        Returns an empty string for synthetic / internal model placeholders
        (e.g. ``<synthetic>``) so callers can skip updating the stored model
        name and preserve the last known real value instead.
        """
        if not full or full.strip("<> ").lower() == "synthetic":
            return ""
        s      = full.lower()
        family = next((l for t, l in (("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")) if t in s), "Claude")
        m      = re.search(r"(\d+)[\.\-](\d+)", s)
        return f"{family} {m.group(1)}.{m.group(2)}" if m else (family if family != "Claude" else full[:28])

    # ── Tool hint / body helpers ──────────────────────────────────────────

    def _hint(self, tool: str, tin: dict) -> str:
        """Return the one-line tool summary shown next to the tool name.

        Uses ``_HINT_FIELDS`` to pick the "most interesting" input field for
        known tools; falls back to the first string value for unknown tools,
        and finally to a JSON snippet if no string is available.
        """
        if f := self._HINT_FIELDS.get(tool):
            if isinstance(tin.get(f), str):
                return tin[f]
        return next((v for v in tin.values() if isinstance(v, str)), json.dumps(tin)[:60])

    def _body(self, tool: str, tin: dict) -> str:
        """Render the full tool-input body shown in the approval card.

        Each recognised tool gets a human-oriented layout (Bash shows
        ``$ cmd``; Edit shows an old/new diff; etc.). Unknown tools fall back
        to a pretty-printed JSON dump. Output is truncated to ~500 chars to
        fit the device display and mobile UI without wrapping.
        """
        if tool == "AskUserQuestion":
            qs = tin.get("questions")
            q  = ((qs[0].get("question") or qs[0].get("header") or "")
                  if isinstance(qs, list) and qs and isinstance(qs[0], dict)
                  else tin.get("question", ""))
            return q.strip()[:500]
        if tool == "Bash":
            cmd, desc = tin.get("command", ""), tin.get("description", "")
            return (f"{desc}\n\n$ {cmd}" if desc else f"$ {cmd}")[:500]
        if tool in ("Edit", "MultiEdit"):
            return (f"{tin.get('file_path', '')}\n\n--- old\n"
                    f"{str(tin.get('old_string', ''))[:180]}\n\n+++ new\n"
                    f"{str(tin.get('new_string', ''))[:180]}")
        if tool == "Write":
            c = str(tin.get("content", ""))
            return f"{tin.get('file_path', '')}\n\n{c[:320]}{'...' if len(c) > 320 else ''}"
        if tool == "WebFetch":
            url, p = tin.get("url", ""), str(tin.get("prompt", ""))[:200]
            return f"{url}\n\n{p}" if p else url
        if tool == "WebSearch":
            return str(tin.get("query", ""))[:300]
        if tool in ("Glob", "Grep"):
            parts = [f"pattern: {tin.get('pattern', '')}"]
            if tin.get("path"): parts.append(f"path: {tin['path']}")
            if tin.get("type"): parts.append(f"type: {tin['type']}")
            return "\n".join(parts)[:300]
        try:
            return json.dumps(tin, indent=2)[:500]
        except Exception:
            return str(tin)[:500]

    # ── Internal helpers ──────────────────────────────────────────────────

    def _add_transcript(self, line: str, sid: str = "") -> None:
        ts    = datetime.now().strftime("%H:%M")
        entry = f"{ts} {line[:80]}"
        with self._lock:
            self._transcript.appendleft(entry)
            if sid:
                q = self._sess_transcript.setdefault(sid, deque(maxlen=20))
                q.appendleft(entry)

    # ── Hook handlers ─────────────────────────────────────────────────────

    def handle_hook(self, payload: dict) -> dict:
        """Entry point for all Claude Code hook events."""
        event = payload.get("hook_event_name", "")

        # The `statusLine.command` mechanism delivers its payload via stdin to
        # the shell script — not via the hooks table — so the payload lacks a
        # hook_event_name field. Detect it by the presence of `context_window`,
        # which only appears in statusline payloads.
        if not event and "context_window" in payload:
            event = "statusline"

        sid   = payload.get("session_id", "")
        _log(f"[hook] {event} session={sid[:8]}")

        if sid and (cwd := payload.get("cwd", "")):
            self._refresh_git(sid, cwd)

        tp = payload.get("transcript_path")

        # Register session on first hook that carries a session_id.
        # Reserve the slot immediately under the lock to prevent a double-registration
        # race between concurrent hook threads. Start time may be refined below.
        if sid:
            with self._lock:
                new_session = sid not in self._sess_start
                if new_session:
                    self._sess_start[sid] = time.time()
                    self._sess_total.add(sid)
                    self._sess_running.add(sid)
            if new_session and tp:
                # Recover actual start time from transcript outside the lock (file I/O).
                recovered = self._transcript_start_time(tp)
                if recovered:
                    with self._lock:
                        self._sess_start[sid] = recovered

        if tp:
            # Transcript is used only as a fallback for model name + latest
            # assistant text. Token metrics come from the statusline hook.
            model, amsg = self._parse_transcript(tp)
            changed = False
            with self._lock:
                if model and sid and (sm := self._short_model(model)):
                    if self._sess_model.get(sid) != sm:
                        self._sess_model[sid]      = sm
                        self._sess_model_full[sid] = model
                        self._model_name           = sm
                        changed = True
                if amsg:
                    if sid and self._sess_assistant.get(sid) != amsg:
                        self._sess_assistant[sid] = amsg
                        changed = True
                    if amsg != self._assistant_msg:
                        self._assistant_msg = amsg
                        changed = True
            if changed:
                self._bump.set()

        try:
            return self._handlers.get(event, lambda p: {})(payload)
        except Exception as e:
            import traceback
            _log(f"[hook] error in {event}: {e!r}\n{traceback.format_exc()}")
            # PreToolUse must return a decision — an empty dict makes Claude
            # fall back to its built-in default which historically has been
            # "ask" (interactive) or "allow" depending on version. Neither is
            # safe when the hub itself is buggy: silently approving on error
            # lets a broken hub run tools unsupervised. Deny explicitly so
            # failure is visible and recoverable.
            if event == "PreToolUse":
                return {"hookSpecificOutput": {
                    "hookEventName":            "PreToolUse",
                    "permissionDecision":       "deny",
                    "permissionDecisionReason": f"buddy hub error: {e}",
                }}
            return {}

    def _on_session_start(self, p: dict) -> dict:
        sid = p.get("session_id", "")
        with self._lock:
            self._sess_total.add(sid)
            self._sess_running.add(sid)
            if sid not in self._sess_start:
                self._sess_start[sid] = time.time()
            self._sess_source[sid] = p.get("source", "startup")
            if (m := p.get("model", "")) and (sm := self._short_model(m)):
                self._sess_model[sid] = sm
            # Read project name inside lock where _sess_meta is safely accessible
            proj = (self._sess_meta.get(sid) or {}).get("project", "")
        self._add_transcript(f"session: {proj}" if proj else "session started", sid)
        self._bump.set()
        return {}

    def _on_session_stop(self, p: dict) -> dict:
        sid = p.get("session_id", "")
        if raw := p.get("last_assistant_message", "").strip():
            # Preserve newlines so Markdown renders correctly in the dashboard.
            clean = self._truncate_markdown(raw)
            with self._lock:
                if sid: self._sess_assistant[sid] = clean
                self._assistant_msg = clean
        with self._lock:
            self._sess_running.discard(sid)
            self._sess_stop_time[sid] = time.time()
        self._add_transcript("session done", sid)
        self._bump.set()
        return {}

    # XML tag pattern used to detect system-injected messages (task
    # notifications, system reminders, etc.) that arrive via UserPromptSubmit
    # but should never appear in the "YOU:" display.
    _SYSTEM_MSG_RE = re.compile(r"^\s*<[a-z\-]+[\s>]", re.IGNORECASE)
    # MCP channel envelopes (Telegram/Discord/iMessage). The inner text IS
    # the user's actual message, just routed through a remote channel — must
    # be unwrapped, not filtered like the system-injected XML above.
    _CHANNEL_MSG_RE = re.compile(
        r"^\s*<channel\b[^>]*>(.*?)</channel>\s*$",
        re.DOTALL | re.IGNORECASE,
    )

    def _on_user_prompt(self, p: dict) -> dict:
        sid = p.get("session_id", "")
        if prompt := (p.get("prompt") or "").strip():
            # Unwrap MCP channel envelopes first — these ARE the user, just
            # arriving from Telegram/Discord/iMessage rather than the terminal.
            if m := self._CHANNEL_MSG_RE.match(prompt):
                prompt = m.group(1).strip()
                if not prompt:
                    return {}
            # Skip system-injected XML payloads (task-notification,
            # system-reminder, etc.) that Claude Code sometimes delivers via
            # this hook. Real user messages never start with an XML tag.
            elif self._SYSTEM_MSG_RE.match(prompt):
                return {}
            clean = self._truncate_markdown(prompt, min_len=300, max_len=800)
            with self._lock:
                if sid:
                    self._sess_human[sid] = clean
                self._human_msg = clean
            self._add_transcript(f"> {prompt[:60]}", sid)
            self._bump.set()
        return {}

    def _on_posttool(self, p: dict) -> dict:
        sid  = p.get("session_id", "")
        tool = p.get("tool_name", "?")

        # Tokens are derived from the transcript JSONL in ``handle_hook`` —
        # Claude Code's PostToolUse payload itself does not carry a ``usage``
        # field, so there is nothing to extract here. The transcript path is
        # idempotent (it re-sums the full file on every hook) and is the
        # single source of truth for input / output / cache totals.
        #
        # Model identity still comes from the payload when present (some
        # Claude Code builds attach the model name to PostToolUse directly).
        if sid and (m := p.get("model")) and isinstance(m, str) and (sm := self._short_model(m)):
            with self._lock:
                self._sess_model[sid]      = sm
                self._sess_model_full[sid] = m
                self._model_name           = sm

        with self._lock:
            counts = self._tool_counts.setdefault(sid, {})
            counts[tool] = counts.get(tool, 0) + 1

        if tool == "Bash":
            resp = p.get("tool_response") or p.get("tool_result") or {}
            if isinstance(resp, dict):
                raw_out   = str(resp.get("output") or resp.get("stdout") or "")
                exit_code = int(resp.get("exit_code") or resp.get("returncode") or 0)
            else:
                raw_out   = str(resp)
                exit_code = 0
            cmd = (p.get("tool_input") or {}).get("command", "")
            with self._lock:
                self._last_cmd[sid] = {
                    "cmd":  cmd[:120],
                    "out":  raw_out.strip()[:300],
                    "code": exit_code,
                }

        self._add_transcript(f"{tool} done", sid)
        self._bump.set()
        return {}

    def _on_posttool_fail(self, p: dict) -> dict:
        sid  = p.get("session_id", "")
        tool = p.get("tool_name", "?")
        err  = str(p.get("error", "error"))[:60]
        with self._lock:
            self._fail_count += 1
            if sid:
                self._sess_fail_count[sid] = self._sess_fail_count.get(sid, 0) + 1
        self._add_transcript(f"{tool} FAIL: {err}", sid)
        self._bump.set()
        return {}

    def _on_notification(self, p: dict) -> dict:
        msg = p.get("message", "").strip()
        if msg:
            self._add_transcript(f"[notify] {msg[:60]}")
            self._bump.set()
        return {}

    def _on_pretool(self, p: dict) -> dict:
        sid  = p.get("session_id", "")
        tool = p.get("tool_name", "?")
        tin  = p.get("tool_input") or {}

        if p.get("permission_mode") == "bypassPermissions":
            self._add_transcript(f"{tool} (bypass)", sid)
            self._bump.set()
            return {"hookSpecificOutput": {
                "hookEventName":            "PreToolUse",
                "permissionDecision":       "allow",
                "permissionDecisionReason": "bypass-permissions mode",
            }}

        kind          = "question" if tool == "AskUserQuestion" else "permission"
        option_labels : list[str] = []
        if kind == "question":
            qs  = tin.get("questions")
            src = ((qs[0].get("options") or [])
                   if isinstance(qs, list) and qs and isinstance(qs[0], dict)
                   else (tin.get("options") or []))
            option_labels = [(o.get("label") if isinstance(o, dict) else str(o)) for o in src[:4]]

        # Use UUID to avoid millisecond-collision with concurrent sessions
        pid    = uuid.uuid4().hex
        ev     = threading.Event()
        holder : dict = {"event": ev, "decision": None}

        prompt_obj = {
            "id": pid, "tool": tool,
            "hint": self._hint(tool, tin),
            "body": self._body(tool, tin),
            "kind": kind, "option_labels": option_labels,
            "session_id": sid,
        }
        # Register _pending alongside _pending_prompts inside the lock —
        # otherwise a dispatched approve/deny that arrives between the two
        # writes could miss the holder and the PreToolUse would time out.
        with self._lock:
            self._pending[pid] = holder
            self._sess_waiting.add(sid)
            self._pending_prompts[pid] = prompt_obj
            if self._active_prompt is None:
                self._active_prompt = prompt_obj
        self._bump.set()

        try:
            decision = holder["decision"] if ev.wait(timeout=30) else None
        finally:
            # Pop _pending inside the lock so _dispatch_command cannot write a decision
            # to a holder that is simultaneously being removed.
            with self._lock:
                self._pending.pop(pid, None)
                self._sess_waiting.discard(sid)
                self._pending_prompts.pop(pid, None)
                if self._active_prompt and self._active_prompt["id"] == pid:
                    self._active_prompt = next(iter(self._pending_prompts.values()), None)
            self._bump.set()

        if isinstance(decision, str) and decision.startswith("option:"):
            try:
                idx = int(decision.split(":", 1)[1])
            except ValueError:
                idx = -1
            label = option_labels[idx] if 0 <= idx < len(option_labels) else ""
            self._add_transcript(f"{tool} → {label[:30]}", sid)
            self._bump.set()
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"User answered on buddy: '{label}' (option {idx+1}). "
                    "Use this answer directly — do NOT call AskUserQuestion again."
                ),
            }}

        if decision == "once":
            with self._lock:
                self._approve_count += 1
                if sid: self._sess_approvals[sid] = self._sess_approvals.get(sid, 0) + 1
            self._add_transcript(f"{tool} allow", sid)
            self._bump.set()
            return {"hookSpecificOutput": {
                "hookEventName":            "PreToolUse",
                "permissionDecision":       "allow",
                "permissionDecisionReason": "Approved on buddy",
            }}

        if decision == "deny":
            with self._lock:
                self._deny_count += 1
                if sid: self._sess_denials[sid] = self._sess_denials.get(sid, 0) + 1
            self._add_transcript(f"{tool} deny", sid)
            self._bump.set()
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    "User cancelled on buddy. Ask directly in terminal."
                    if kind == "question" else "Denied on buddy"
                ),
            }}

        self._add_transcript(f"{tool} timeout", sid)
        self._bump.set()
        # Explicit deny on timeout: returning {} would defer to Claude Code's
        # built-in default (historically "ask" or "allow" by version), which
        # could silently approve a tool call the user never saw. Fail closed.
        return {"hookSpecificOutput": {
            "hookEventName":            "PreToolUse",
            "permissionDecision":       "deny",
            "permissionDecisionReason": "buddy hub: no user decision within 30s",
        }}

    # ── Statusline ────────────────────────────────────────────────────────

    def _on_statusline(self, p: dict) -> dict:
        """Handle the ``statusline`` hook — Claude Code's authoritative metrics push.

        Fires every few seconds during an active session. The payload contains
        Claude Code's own pre-computed values for context usage, cost, token
        counts, and code-change statistics — all more accurate than our own
        estimates derived from transcript parsing or git diffs.

        Fields consumed from ``p``:
            - ``context_window.used_percentage``  → ``_sess_context_pct``
            - ``context_window.context_window_size`` → ``_sess_context_sz``
            - ``context_window.total_input_tokens``  → ``_input_tokens``
            - ``context_window.total_output_tokens`` → ``_output_tokens``
            - ``context_window.current_usage.cache_read_input_tokens`` → ``_cache_tokens``
            - ``cost.total_cost_usd``             → ``_sess_cost``
            - ``cost.total_lines_added``           → ``_sess_lines_added``
            - ``cost.total_lines_removed``         → ``_sess_lines_removed``
            - ``model.display_name`` / ``model.id`` → ``_sess_model`` / ``_sess_model_full``
        """
        sid = p.get("session_id", "")
        if not sid:
            return {}

        ctx_win = p.get("context_window") or {}
        cur     = ctx_win.get("current_usage") or {}
        cost    = p.get("cost") or {}
        model   = p.get("model") or {}

        changed = False
        with self._lock:
            def _set(d: dict, key: str, val) -> None:
                nonlocal changed
                if val is not None and d.get(key) != val:
                    d[key] = val
                    changed = True

            _set(self._sess_context_pct,   sid, ctx_win.get("used_percentage"))
            _set(self._sess_context_sz,    sid, ctx_win.get("context_window_size"))
            _set(self._input_tokens,       sid, ctx_win.get("total_input_tokens"))
            _set(self._output_tokens,      sid, ctx_win.get("total_output_tokens"))
            _set(self._cache_tokens,       sid, cur.get("cache_read_input_tokens"))
            _set(self._sess_cost,          sid, cost.get("total_cost_usd"))
            _set(self._sess_lines_added,   sid, cost.get("total_lines_added"))
            _set(self._sess_lines_removed, sid, cost.get("total_lines_removed"))

            # Skip synthetic/internal model placeholders — keep the last real value.
            raw_display = model.get("display_name") or ""
            display = raw_display if raw_display.strip("<> ").lower() != "synthetic" else ""
            if display and self._sess_model.get(sid) != display:
                self._sess_model[sid]      = display
                self._sess_model_full[sid] = model.get("id") or display
                self._model_name           = display
                changed = True

        if changed:
            self._bump.set()
        return {}

    # ── Start ─────────────────────────────────────────────────────────────

    def start(self, on_connect: Callable | None = None) -> None:
        """
        Start the heartbeat loop and transport.

        @param on_connect - called once the transport connects (used for device handshake)
        """
        self.transport.start(self.on_rx_byte, on_connect=on_connect)
        threading.Thread(target=self._heartbeat_loop, daemon=True, name="heartbeat").start()
