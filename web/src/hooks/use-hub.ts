'use client';

/**
 * @file WebSocket hook for real-time BuddyHub state.
 *
 * Connects to the BuddyHub WebSocket endpoint, consumes heartbeat snapshots,
 * and exposes action dispatchers (approve, deny, sendOption, focusSession).
 * Reconnects automatically with exponential backoff capped at 30 s. A JSON
 * ping fires every 25 s so proxies don't idle the socket out.
 *
 * Endpoint resolution is done at call time from `window.location`, so the
 * same built bundle serves `localhost`, `127.0.0.1`, and any LAN IP without
 * rebuilding. The auth token is read from `?token=...` ONLY — never baked
 * in at build time — so the token never ships inside the JS bundle.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { HubHeartbeat } from '@/types/hub';

const PING_INTERVAL   = 25_000; // ms — keep-alive within proxy timeout windows
const RECONNECT_BASE  = 1_000;  // ms — starting backoff for the first retry
const RECONNECT_MAX   = 30_000; // ms — cap so reconnects never drift to hours
const RECONNECT_CAP   = 10;     // cap the backoff exponent, not the attempt count

/** Private WebSocket close code (range 4000-4999) used by the hub for auth failures. */
const CLOSE_UNAUTHORIZED = 4401;

/**
 * Resolve the WebSocket endpoint at call time.
 *
 * Token comes from `?token=...` in the current page URL, period. We
 * deliberately do NOT fall back to a build-time env variable for the token —
 * baking it into the JS bundle would leak it to anyone who can load the page
 * (including LAN strangers who would otherwise be blocked by the hub).
 * Either the URL carries it, or the hub must be running without auth.
 *
 * A full endpoint override via `NEXT_PUBLIC_HUB_WS_URL` is still allowed for
 * deployments where the hub runs on a different host than the web UI; that
 * URL is expected to already include its own `?token=...` if needed.
 *
 * SSR returns the empty string so the first server-rendered markup matches
 * the first client render (both have no URL yet); the actual URL is set
 * from a `useEffect` once `window` is available.
 *
 * @returns The WebSocket URL to connect to, or `''` during SSR / before mount.
 */
function resolveWsUrl(): string {
  if (process.env.NEXT_PUBLIC_HUB_WS_URL) return process.env.NEXT_PUBLIC_HUB_WS_URL;
  if (typeof window === 'undefined') return '';
  const token = new URL(window.location.href).searchParams.get('token') ?? '';
  const qs    = token ? `?token=${encodeURIComponent(token)}` : '';
  return `ws://${window.location.hostname}:7382${qs}`;
}

/**
 * Return shape of {@link useHub}.
 *
 * All command dispatchers are no-ops when the socket is not in OPEN state,
 * so callers can fire them eagerly without checking `connected`.
 */
export interface UseHubReturn {
  /** Latest heartbeat snapshot, or `null` before the first message arrives. */
  heartbeat:   HubHeartbeat | null;
  /** True while the WebSocket is open and receiving heartbeats. */
  connected:   boolean;
  /** The WebSocket URL the hook is actually connecting to (empty during SSR). */
  wsUrl:       string;
  /**
   * True when the hub closed our connection with code 4401 (bad/missing
   * token). The UI should surface a permanent error instead of the normal
   * reconnect spinner; sending an approve/deny will do nothing until the
   * user reloads with a correct `?token=...` in the URL.
   */
  authError:   boolean;
  /** Approve the currently-pending PreToolUse prompt with the given prompt ID. */
  approve:     (id: string) => void;
  /** Deny the currently-pending PreToolUse prompt with the given prompt ID. */
  deny:        (id: string) => void;
  /** Pick option `index` (0-based) from a multi-choice prompt. */
  sendOption:  (id: string, index: number) => void;
  /** Ask the hub to focus session `sid` — subsequent heartbeats carry its details. */
  focusSession:(sid: string) => void;
}

/**
 * React hook that connects to BuddyHub over WebSocket.
 *
 * Lifecycle: opens a socket on mount, pings every 25 s, replaces the
 * heartbeat state on each `_live` frame, reconnects with exponential
 * backoff (1 s → 2 s → 4 s ... capped at 30 s) on any close other than
 * `4401`. Close code `4401` halts reconnection and sets `authError`.
 *
 * @returns An object with the latest `heartbeat`, connection booleans,
 *   the live `wsUrl`, and four command dispatchers. See {@link UseHubReturn}
 *   for the full field list.
 */
export function useHub(): UseHubReturn {
  const [connected, setConnected] = useState(false);
  const [heartbeat, setHeartbeat] = useState<HubHeartbeat | null>(null);
  const [authError, setAuthError] = useState(false);
  // Empty on SSR and first client render so hydration matches; the effect
  // populates it with the real URL after mount.
  const [wsUrl,     setWsUrl]     = useState<string>('');

  const wsRef         = useRef<WebSocket | null>(null);
  const retryTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer     = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryAttempts = useRef(0);
  const unmounted     = useRef(false);

  const send = useCallback((obj: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(obj));
    }
  }, []);

  const approve      = useCallback((id: string)                => send({ cmd: 'approve', id }),        [send]);
  const deny         = useCallback((id: string)                => send({ cmd: 'deny',    id }),        [send]);
  const sendOption   = useCallback((id: string, index: number) => send({ cmd: 'option',  id, index }), [send]);
  const focusSession = useCallback((sid: string)               => send({ cmd: 'focus',   sid }),       [send]);

  useEffect(() => {
    unmounted.current = false;
    const url = resolveWsUrl();
    setWsUrl(url);
    if (!url) return; // SSR — nothing to connect to

    function clearPing(): void {
      if (pingTimer.current) {
        clearInterval(pingTimer.current);
        pingTimer.current = null;
      }
    }
    function clearRetry(): void {
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    }

    function connect(): void {
      if (unmounted.current) return;
      clearRetry();

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmounted.current) { ws.close(); return; }
        setConnected(true);
        retryAttempts.current = 0;
        clearPing();
        pingTimer.current = setInterval(() => {
          // Send a JSON ping so the server's strict JSON parser treats it
          // the same as any other command instead of falling through to the
          // decode-error branch.
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ cmd: 'ping' }));
          }
        }, PING_INTERVAL);
      };

      ws.onmessage = (e: MessageEvent) => {
        let obj: unknown;
        try {
          obj = JSON.parse(e.data as string);
        } catch {
          return;
        }
        // Accept only live heartbeat snapshots. Ignoring unrecognised frames
        // prevents a future ack/error message from wiping the current UI
        // state (every heartbeat replaces it wholesale).
        if (obj && typeof obj === 'object' && (obj as { _live?: unknown })._live === true) {
          setHeartbeat(obj as HubHeartbeat);
        }
      };

      ws.onclose = (ev) => {
        clearPing();
        // Also drop any retry timer a previous close may have scheduled —
        // otherwise a rapid close-reopen sequence leaks timers and can
        // spawn multiple parallel reconnect attempts.
        clearRetry();
        if (unmounted.current) return;
        setConnected(false);
        // 4401 = hub rejected the token. Reconnecting won't help — the URL
        // itself needs a new token — so halt the retry loop and let the UI
        // show a permanent "unauthorized" state.
        if (ev.code === CLOSE_UNAUTHORIZED) {
          setAuthError(true);
          return;
        }
        scheduleReconnect();
      };

      ws.onerror = () => ws.close();
    }

    function scheduleReconnect(): void {
      if (unmounted.current) return;
      clearRetry();
      const exponent = Math.min(retryAttempts.current, RECONNECT_CAP);
      const delay    = Math.min(RECONNECT_BASE * 2 ** exponent, RECONNECT_MAX);
      retryAttempts.current++;
      retryTimer.current = setTimeout(connect, delay);
    }

    connect();

    return () => {
      unmounted.current = true;
      clearRetry();
      clearPing();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  return { heartbeat, connected, wsUrl, authError, approve, deny, sendOption, focusSession };
}
