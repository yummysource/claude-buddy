"""
HTTP + WebSocket server layer.

Responsibilities:
- HTTP (port 7381): receive Claude Code hook POSTs at /hook, forward to BuddyHub
- WebSocket (port 7382): push heartbeat snapshots to browser clients, receive approve/deny commands

ThreadingMixIn ensures PreToolUse blocking (up to 30 s) does not freeze
other concurrent hook requests on the same HTTP server.

The web frontend (Next.js, port 3000) is served independently and connects
directly to the WebSocket port — this server does not serve static files.
"""
from __future__ import annotations

import asyncio
import json
import socketserver
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from .hub import BuddyHub


def _log(*a):
    print(*a, file=sys.stderr, flush=True)


class _ThreadedHTTP(socketserver.ThreadingMixIn, HTTPServer):
    """HTTP server with per-request threads.

    Thread-per-request is required because PreToolUse blocks for up to 30 s
    waiting for an approve/deny decision — a single-threaded server would stall
    all subsequent hook deliveries during that window.
    """
    daemon_threads = True


class HubServer:
    """
    Owns the HTTP hook endpoint and WebSocket broadcast server.

    @param hub      - BuddyHub instance providing heartbeat + command dispatch
    @param ws_host  - Bind address for the WebSocket port. Default 127.0.0.1
                      (loopback only). Pass 0.0.0.0 to accept LAN clients —
                      a non-loopback bind REQUIRES a token (callers enforce).
    @param ws_token - Optional shared secret. When set, incoming WS
                      connections must present it as a `?token=...` query
                      parameter; others are closed with code 4401.

    The HTTP hook port is always bound to 127.0.0.1 — Claude Code runs on
    the same machine as the hub by definition, and it has no way to attach
    a custom auth header, so exposing HTTP on the LAN would be strictly
    attack surface.
    """

    def __init__(self, hub: BuddyHub, *,
                 ws_host: str = "127.0.0.1",
                 ws_token: str | None = None):
        self._hub        = hub
        self._ws_host    = ws_host
        self._ws_token   = ws_token
        self._ws_loop    : asyncio.AbstractEventLoop | None = None
        self._ws_ready   = threading.Event()   # set once the event loop is running
        self._ws_clients : set = set()
        self._ws_lock    = threading.Lock()

        # Register the broadcast callback on the hub
        hub.set_broadcast(self._broadcast)

    # ── WebSocket ─────────────────────────────────────────────────────────

    @staticmethod
    def _log_send_failure(fut: "asyncio.Future") -> None:
        """
        Surface send-coroutine exceptions that would otherwise disappear into
        a dropped Future. Ordinary client disconnects (ConnectionClosed*)
        are expected and suppressed; anything else is a real bug we want
        visible in stderr.
        """
        exc = fut.exception()
        if exc is None:
            return
        name = type(exc).__name__
        if name in ("ConnectionClosed", "ConnectionClosedOK", "ConnectionClosedError"):
            return
        _log(f"[ws] send failed: {exc!r}")

    def _broadcast(self, obj: dict) -> None:
        """Send a heartbeat snapshot to all connected WebSocket clients."""
        # Wait briefly for the WS loop to be ready before first broadcast.
        if not self._ws_ready.wait(timeout=5):
            return
        loop = self._ws_loop
        if not loop:
            return
        data = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
        with self._ws_lock:
            clients = set(self._ws_clients)
        for ws in clients:
            try:
                fut = asyncio.run_coroutine_threadsafe(ws.send(data), loop)
                fut.add_done_callback(self._log_send_failure)
            except Exception as e:
                _log(f"[ws] schedule failed: {e!r}")

    def _extract_token(self, websocket) -> str | None:
        """
        Pull the `token` query parameter out of the initial HTTP handshake.

        Different websockets-library versions expose the request path via
        different attributes (`request.path`, `path`, `request_uri`); we
        check all of them to stay version-agnostic.
        """
        path = ""
        req  = getattr(websocket, "request", None)
        if req is not None:
            path = getattr(req, "path", "") or getattr(req, "request_uri", "") or ""
        if not path:
            path = getattr(websocket, "path", "") or ""
        if not path:
            return None
        q = parse_qs(urlparse(path).query)
        return (q.get("token") or [None])[0]

    async def _ws_handler(self, websocket) -> None:
        # Auth gate — reject before touching client set so unauthorized
        # peers never count toward _ws_clients and never receive heartbeats.
        if self._ws_token:
            supplied = self._extract_token(websocket)
            if supplied != self._ws_token:
                # 4401 is in the private range (4000-4999). The frontend
                # treats it as "do not auto-reconnect" so a wrong token
                # surfaces as a clear error instead of a silent retry loop.
                await websocket.close(code=4401, reason="unauthorized")
                return

        with self._ws_lock:
            self._ws_clients.add(websocket)
        try:
            # Send current state immediately on connect
            await websocket.send(
                json.dumps(self._hub.build_heartbeat(), separators=(",", ":"), ensure_ascii=False))
            async for msg in websocket:
                # Accept both the legacy bare "ping" keepalive and the
                # preferred { "cmd": "ping" } JSON form so old clients keep
                # working while new ones stay purely JSON.
                if msg == "ping":
                    continue
                try:
                    obj = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                self._hub.dispatch_ws_command(obj)
        except Exception:
            pass
        finally:
            with self._ws_lock:
                self._ws_clients.discard(websocket)

    def _ws_thread(self) -> None:
        try:
            import websockets
        except ImportError:
            _log("[ws] websockets not installed — run: uv add websockets")
            return

        async def _serve():
            async with websockets.serve(self._ws_handler, self._ws_host, self._hub.ws_port):
                auth = " (token required)" if self._ws_token else ""
                _log(f"[ws]   ws://{self._ws_host}:{self._hub.ws_port}{auth}")
                # Signal that the loop is live so _broadcast can proceed.
                self._ws_loop = asyncio.get_running_loop()
                self._ws_ready.set()
                # Run indefinitely — this coroutine owns the server lifetime.
                await asyncio.Future()

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(_serve())

    # ── HTTP ──────────────────────────────────────────────────────────────

    def _make_http_handler(self):
        hub = self._hub

        class _Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                # Log errors but suppress routine 200-OK access logs.
                code = args[1] if len(args) > 1 else ""
                if str(code).startswith(("4", "5")):
                    _log(f"[http] {self.address_string()} {fmt % args}")

            def do_HEAD(self):
                self._raw(200, "text/plain", b"")

            def do_GET(self):
                # Browser health-check or accidental visit — redirect to the web UI.
                self.send_response(302)
                self.send_header("Location", "http://localhost:3000")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_POST(self):
                # Only /hook is a valid endpoint; reject everything else.
                if self.path not in ("/", "/hook"):
                    return self._json(404, {"error": "not found"})
                try:
                    n       = int(self.headers.get("Content-Length") or "0")
                    body    = self.rfile.read(n) if n else b""
                    payload = json.loads(body.decode()) if body else {}
                except Exception as e:
                    return self._json(400, {"error": str(e)})
                self._json(200, hub.handle_hook(payload))

            def _json(self, code: int, obj: dict) -> None:
                self._raw(code, "application/json", json.dumps(obj).encode())

            def _raw(self, code: int, ct: str, data: bytes) -> None:
                try:
                    self.send_response(code)
                    self.send_header("Content-Type", ct)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        return _Handler

    # ── Start ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the WebSocket thread and block on the HTTP server."""
        threading.Thread(target=self._ws_thread, daemon=True, name="ws-server").start()

        # HTTP is loopback-only by design (see class docstring).
        srv = _ThreadedHTTP(("127.0.0.1", self._hub.http_port), self._make_http_handler())
        _log(f"[http] 127.0.0.1:{self._hub.http_port}")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            _log("\n[exit] bye")
