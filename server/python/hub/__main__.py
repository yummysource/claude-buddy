"""
Entry point — parse CLI arguments, wire up hub + server, and start.

Usage:
    python -m hub                              # loopback-only, no auth needed
    python -m hub --host 0.0.0.0               # LAN-accessible, token required
    python -m hub --host 0.0.0.0 --no-auth     # LAN-accessible, no auth (trusted net only)
    python -m hub --transport none
    python -m hub --port 7381 --ws-port 7382
"""
from __future__ import annotations

import argparse
import os
import secrets
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .hub import BuddyHub
from .server import HubServer
from .transports import make_transport


# Bind addresses treated as "loopback only" — connections from the LAN
# cannot reach them, so no token is needed for the inherent safety goal.
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}

# Where the auto-generated WebSocket token is persisted so UI bookmarks
# survive hub restarts. Permissions set to 0600 so other users on the
# machine cannot read it.
TOKEN_PATH = Path.home() / ".config" / "claude-buddy" / "token"

# Sentinel returned by argparse when the user typed `--token` with no value,
# signalling "rotate the token now". Any sentinel-shaped singleton works; an
# object() avoids conflicting with a real token value the user might type.
_TOKEN_ROTATE = object()


def _tz_offset() -> int:
    """Return the local UTC offset in seconds (positive = east of UTC)."""
    off = datetime.now(timezone.utc).astimezone().utcoffset()
    return -int(off.total_seconds()) if off else 0


def _positive_int(value: str) -> int:
    """argparse type that rejects negative budgets rather than silently clamping."""
    n = int(value)
    if n < 0:
        raise argparse.ArgumentTypeError(f"budget must be >= 0, got {n}")
    return n


def _write_token(token: str) -> None:
    """Persist `token` to the shared file with 0600 permissions."""
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(token)
    try:
        TOKEN_PATH.chmod(0o600)
    except OSError:
        pass


def _resolve_token(host: str, explicit, no_auth: bool) -> str | None:
    """
    Decide which token (if any) the WebSocket server should enforce.

    Argument shapes for ``explicit``:
      - ``None``          — user did not pass --token; reuse the persisted
                            file (generating + saving one on first run).
      - ``_TOKEN_ROTATE`` — user passed ``--token`` with no value; generate
                            a fresh token AND overwrite the persisted file.
                            Existing bookmarks pointing at the old token
                            will stop working.
      - any other string  — user passed ``--token VALUE``; use it for this
                            run only (the persisted file is left untouched).

    Loopback binds and --no-auth short-circuit to ``None`` regardless.
    """
    if host in LOOPBACK_HOSTS:
        return None
    if no_auth:
        return None
    if explicit is _TOKEN_ROTATE:
        token = secrets.token_urlsafe(16)
        _write_token(token)
        return token
    if isinstance(explicit, str) and explicit:
        return explicit
    if TOKEN_PATH.exists():
        try:
            return TOKEN_PATH.read_text().strip() or None
        except OSError:
            pass
    token = secrets.token_urlsafe(16)
    _write_token(token)
    return token


def _lan_ips() -> list[str]:
    """Best-effort enumeration of this machine's non-loopback IPv4 addresses."""
    addrs: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in addrs:
                addrs.append(ip)
    except socket.gaierror:
        pass
    return addrs


def _print_access_banner(host: str, ws_port: int, token: str | None) -> None:
    """
    Print copy-paste URLs for localhost + every LAN IP we can detect.

    The token is embedded in EVERY URL including localhost, because the
    frontend no longer reads a build-time fallback — baking the token into
    the JS bundle would leak it to anyone who hits :3000. Users should copy
    a full URL from this banner rather than typing http://localhost:3000
    by hand.
    """
    qs = f"?token={token}" if token else ""
    print("", file=sys.stderr, flush=True)
    print("  Access:", file=sys.stderr, flush=True)
    print(f"    http://localhost:3000{qs}", file=sys.stderr, flush=True)
    if host not in LOOPBACK_HOSTS:
        for ip in _lan_ips():
            print(f"    http://{ip}:3000{qs}", file=sys.stderr, flush=True)
    if token:
        print("", file=sys.stderr, flush=True)
        print(f"  WebSocket token: {token}", file=sys.stderr, flush=True)
        print(f"  (stored at {TOKEN_PATH})", file=sys.stderr, flush=True)
    print("", file=sys.stderr, flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="claude-code-buddy hub server")
    ap.add_argument("--transport", default="auto",
                    choices=["auto", "serial", "ble", "none"],
                    help="hardware transport (default: auto)")
    ap.add_argument("--port",     type=int, default=7381,
                    help="HTTP hook listener port (default: 7381, always bound to 127.0.0.1)")
    ap.add_argument("--ws-port",  type=int, default=7382,
                    help="WebSocket push port (default: 7382)")
    ap.add_argument("--host",     default="127.0.0.1",
                    help="WebSocket bind address. Default 127.0.0.1 (loopback). "
                         "Pass 0.0.0.0 to accept LAN connections — a token is required "
                         "unless --no-auth is also given.")
    ap.add_argument("--token",    nargs="?", const=_TOKEN_ROTATE, default=None,
                    help="WebSocket auth token. "
                         "Without --token: reuse (or first-time generate) the "
                         "persisted token at ~/.config/claude-buddy/token. "
                         "Bare --token with no value: rotate the persisted "
                         "token to a freshly-generated one. "
                         "--token VALUE: use VALUE for this run only, leaving "
                         "the persisted file untouched. "
                         "Ignored on loopback binds.")
    ap.add_argument("--no-auth",  action="store_true",
                    help="Disable WebSocket token auth even on a LAN bind. "
                         "Use only on trusted networks.")
    ap.add_argument("--budget",   type=_positive_int, default=200000,
                    help="context-window token budget for progress bar, 0 = hide (default: 200000)")
    ap.add_argument("--owner",    default=os.environ.get("USER", ""),
                    help="owner name shown in the dashboard header")
    ap.add_argument("--serial-port", default=None,
                    help="explicit serial device path (overrides --transport)")
    args = ap.parse_args()

    if args.port == args.ws_port:
        ap.error(f"--port and --ws-port must differ (both {args.port})")

    token = _resolve_token(args.host, args.token, args.no_auth)

    transport = make_transport(args.transport, args.serial_port)

    hub = BuddyHub(
        transport = transport,
        http_port = args.port,
        ws_port   = args.ws_port,
        budget    = args.budget,
        owner     = args.owner,
    )

    server = HubServer(hub, ws_host=args.host, ws_token=token)

    # on_connect sends the initial device handshake via the transport (e.g. hardware display).
    # Greeting is sent through the hub's public send_greeting() so _send stays private.
    def _on_connect() -> None:
        hub.send_greeting(int(time.time()), _tz_offset())

    hub.start(on_connect=_on_connect)
    _print_access_banner(args.host, args.ws_port, token)
    server.start()


if __name__ == "__main__":
    main()
