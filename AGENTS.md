# Agent Guidelines

This document defines rules for AI agents (Claude Code, Copilot, etc.) working in this repository.

## Language

- All code, comments, commit messages, and documentation must be written in **English**.
- No Chinese or other languages in source files. Translations live only in `README.zh-CN.md` / `README.zh-TW.md` and `DASHBOARD.zh-CN.md` / `DASHBOARD.zh-TW.md`.

## Code Style

### General

- Prefer clarity over cleverness. Code is read far more often than it is written.
- Do not add comments that restate what the code does. Only comment the **why** when it is non-obvious.
- No dead code, unused imports, or commented-out blocks.
- No backwards-compatibility shims unless explicitly required.

### Python (`server/python/`)

- Python ≥ 3.11. Use modern syntax: `str | None`, `match`, `from __future__ import annotations`.
- Use `uv` for all dependency management. Never use `pip` directly.
- All public classes, functions, and methods must have docstrings describing **purpose**, **args**, **returns**, **raises**, and any **concurrency constraints** (held locks, thread of execution).
- Run `uv run python -m py_compile hub/*.py` after every change.

### TypeScript / React (`web/`)

- Runtime: Bun 1.x preferred; Node ≥ 20 works. `next.config.ts` is free to import Node built-ins (`node:os`, `node:fs`, etc.) — it runs at build time, not in the browser.
- Framework: Next.js 16 (Turbopack) + React 19 + Tailwind CSS v4.
- All public components, hooks, and utilities must have JSDoc comments following `~/.claude/rules/jsdoc.md` — use standard tags (`@param`, `@returns`, `@throws`); `@param` names match actual parameter identifiers, not nested property paths.
- Styling uses Tailwind utility classes in `className`. Global custom utilities live in `web/src/app/globals.css` (`.glass-panel`, `.gilded-glow`, etc.). Do not introduce new stylesheet files.
- Tailwind v4 JIT scans source files (including comments) for class literals. Avoid writing Tailwind-shaped strings inside comments (e.g. `pb-[env(...)]`) — they will be compiled and can produce invalid CSS.
- Run `bun run build` after every change — it does both the TypeScript check and the bundle build.

### Go (`server/go/`)

- **Planned; not yet present in the repository.** When added, it must expose the same WebSocket schema as `server/python/` and follow standard Go conventions (`gofmt`, `golint`, doc comments on all exported symbols).

## Concurrency (Python hub)

- All mutable state on `BuddyHub` lives in dicts/sets guarded by `self._lock`.
- **Hold the lock only long enough to read or mutate state.** Never perform I/O under the lock: no `subprocess.run`, no `transport.write`, no file reads, no WebSocket sends. A PreToolUse handler can block for up to 30 s and would stall every unrelated hook otherwise.
- Cross-thread state flips (HTTP hook thread ↔ asyncio WS thread ↔ heartbeat thread) must use `threading.Event` or `asyncio.run_coroutine_threadsafe`; do not share Python data structures that mutate during iteration.

## Per-Session State

- Every piece of session-scoped data lives in a dict keyed by `session_id` (`_sess_*`, `_input_tokens`, `_tool_counts`, `_last_cmd`, …).
- **When you add a new per-session dict, also add it to `_purge_expired_sessions()`.** Forgetting this causes unbounded memory growth across long-running hubs.
- The heartbeat builder (`build_heartbeat`) must never fall back to a global value when a `sid` is available — cross-session contamination is a known regression vector. Missing data should result in the field being absent from the heartbeat, not filled with another session's value.

## Auth & Bundle Safety

- HTTP hook port (7381) is **always bound to `127.0.0.1`**, regardless of `--host`. Claude Code runs on the same machine as the hub; exposing this port on the LAN is strictly attack surface.
- WebSocket port (7382) binds to `--host` (default `127.0.0.1`). Any non-loopback bind **requires a token** unless `--no-auth` is explicitly set.
- **Never ship a hub token inside the browser bundle.** Specifically: do not read `~/.config/claude-buddy/token` from `next.config.ts` and expose it via a `NEXT_PUBLIC_*` variable. The token must come from the URL `?token=...` only, so that anyone who can fetch `/` can still be rejected at the WebSocket layer.
- The `NEXT_PUBLIC_HUB_WS_URL` override exists for setups where the hub runs on a different host than the web UI — if used, the full URL (including any token) is the operator's responsibility.

## Architecture Rules

- The web frontend (`web/`) connects **directly** to the hub WebSocket. It must not depend on the Python or Go server to serve its assets.
- The hub server (`server/`) must not import or depend on anything in `web/`.
- `server/python/hub/transports.py` must remain the only file that imports hardware-specific libraries (e.g. `bleak`, `pyserial`). Core hub logic must work with `--transport none`.
- The Python and future Go hub implementations must expose the **same WebSocket message schema** and the **same HTTP hook schema**. Any schema change must be reflected in both.

## WebSocket & Hook Protocol

Hub pushes full-snapshot JSON heartbeats over WebSocket. Clients send JSON commands back:

```
{ cmd: "approve" | "deny",       id: <pid> }
{ cmd: "option", id: <pid>, index: <n> }
{ cmd: "focus",  sid: <full session id> }
{ cmd: "ping" }                           # keep-alive, ignored server-side
```

Heartbeat frames carry `_live: true`; the client ignores any frame without that sentinel so future ack/error messages cannot wipe UI state.

**Schema changes require updating, in the same PR:**

1. The server implementation that introduces the change (`server/python/hub/hub.py` — heartbeat builder, command dispatcher, or hook handlers).
2. The frontend types: `web/src/types/hub.ts` (field definitions) and `web/src/hooks/use-hub.ts` (command senders).
3. The dashboard reference documentation: `DASHBOARD.md`, `DASHBOARD.zh-CN.md`, and `DASHBOARD.zh-TW.md` — keep the three in lockstep.
4. If the change adds user-visible commands or CLI flags, update `README.md`, `README.zh-CN.md`, and `README.zh-TW.md` as well.

## Frontend Hydration

- Anything that depends on the browser environment — `window.*`, `document.*`, `Date.now()`, `localStorage`, `window.location.hostname`, etc. — **must** run inside a `useEffect`, never in the render body or a `useState` initializer.
- Server-rendered and first-client-rendered markup must match exactly. When a value is only available after mount, initialize state with a neutral placeholder (e.g. `''` or `null`) and populate it from the effect. See `useHub` / `wsUrl` for the canonical pattern.

## Commits

- Commit messages in English, imperative mood: `Fix session TTL expiry`, not `Fixed` or `Fixing`.
- One logical change per commit.
- Do not commit `.venv/`, `node_modules/`, build artifacts, or the auto-generated `~/.config/claude-buddy/token`.
- Do not include AI tool attribution (e.g. `Co-Authored-By: Claude`) in commit messages.

## Verification Checklist

Run before concluding a change:

- Python edits → `cd server/python && uv run python -m py_compile hub/*.py`
- Frontend edits → `cd web && bun run build` (runs TypeScript check + Turbopack build)
- Edits that touch startup flags, security posture, or hook schema → manually start the hub and a browser session to confirm behavior

## What NOT to Do

- Do not start a background polling thread or timer unless the user explicitly requests it.
- Do not add features beyond the current task scope.
- Do not generate or guess external URLs.
- Do not modify `hooks/settings.json` format without updating **all six** documentation files (three READMEs + three DASHBOARDs).
- Do not expand the hub's HTTP port beyond `127.0.0.1`; do not remove the token check on LAN binds.
- Do not add `NEXT_PUBLIC_HUB_TOKEN` (or any other way of baking the token into the built bundle).
