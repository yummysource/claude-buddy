# CLAUDE.md

Project-specific rules for Claude Code. These override global defaults where they conflict.

See [AGENTS.md](AGENTS.md) for the full set of rules shared across all agents.

## Quick Reference

- **Language**: English only in all source files and commits.
- **Python**: use `uv run` for everything; `py_compile` after every change.
- **Frontend**: Next.js 16 + shadcn/ui (Bun); connects to hub WebSocket at `ws://localhost:7382`.
- **Comments**: explain the *why*, never the *what*.

## Project Layout

```
claude-code-buddy/
├── AGENTS.md           agent and coding rules (read this first)
├── hooks/              Claude Code hook config template
├── server/
│   ├── python/         Python hub — entry: python -m hub
│   └── go/             Go hub (in progress)
└── web/                Next.js 16 + shadcn/ui frontend — entry: bun run dev
```

## Running Locally

```bash
# Hub (Python)
cd server/python
uv run python -m hub --transport none

# Web frontend
cd web
bun run dev
```

## Key Ports

| Service | Port |
|---------|------|
| HTTP hook listener | 7381 |
| WebSocket push | 7382 |
| Web frontend (Next.js) | 3000 |
