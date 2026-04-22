'use client';

/**
 * @file Sessions list shown in the fixed desktop sidebar and the mobile drawer.
 *
 * Each item shows the project name, git branch, and a color-coded status
 * dot (green pulse = running, yellow = waiting on user, grey = idle).
 * Clicking a row sends a `focus` command to the hub; the hub replies with a
 * fresh heartbeat whose focused-session fields describe that row.
 */

import { cn } from '@/lib/utils';
import type { HubSession } from '@/types/hub';

interface SidebarProps {
  /** Sessions to list (hub emits up to 5, newest-first). */
  sessions:    HubSession[];
  /** Focus handler — receives the session's full ID, not the 8-char `sid`. */
  onFocus:     (sid: string) => void;
  /** Live WS URL — shown in the footer so LAN users can verify the endpoint. */
  wsUrl:       string;
  /** WebSocket connection state — colors the footer dot. */
  connected:   boolean;
  /** Mobile drawer open state (ignored on `md`+ screens). */
  mobileOpen?: boolean;
  /** Called when the mobile backdrop is tapped to close the drawer. */
  onClose?:    () => void;
}

/**
 * Session status indicator.
 *
 * Three visual states: pulsing green (running), solid yellow (waiting on
 * user input), dim grey (idle). The pulse animation only renders for running
 * sessions so an idle list doesn't visually flicker.
 *
 * @param props - Component props.
 * @param props.running - True while Claude is producing a response.
 * @param props.waiting - True when the session is idle after a Stop event.
 * @returns The status dot.
 */
function StatusDot({ running, waiting }: { running: boolean; waiting: boolean }) {
  if (running) {
    return (
      <span className="relative flex-shrink-0 flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
      </span>
    );
  }
  if (waiting) {
    return <span className="flex-shrink-0 h-2 w-2 rounded-full bg-yellow-400" />;
  }
  return <span className="flex-shrink-0 h-2 w-2 rounded-full bg-muted-foreground/30" />;
}

/**
 * Single sidebar row for one session.
 *
 * Renders status dot + project name + branch (with `~N` suffix for dirty
 * file count). Clicking dispatches `focus` with the session's `full` ID —
 * the truncated `sid` would be ambiguous on a busy host.
 *
 * @param props - Component props.
 * @param props.session - Session data for this row.
 * @param props.onFocus - Focus handler (receives the full ID).
 * @returns A clickable session row.
 */
function SessionItem({
  session,
  onFocus,
}: {
  session: HubSession;
  onFocus: (sid: string) => void;
}) {
  const active = session.focused;

  return (
    <button
      onClick={() => onFocus(session.full)}
      className={cn(
        'w-full text-left py-3 px-6 flex items-center gap-3',
        'font-headline uppercase text-xs tracking-widest',
        'transition-all duration-200 hover:translate-x-1',
        active
          ? 'text-primary bg-primary/5 border-r-2 border-primary'
          : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
      )}
    >
      <StatusDot running={session.running} waiting={session.waiting} />
      <div className="flex flex-col min-w-0">
        <span className="truncate">
          {session.proj || session.sid}
        </span>
        {session.branch && (
          <span className="text-[9px] font-mono opacity-50 truncate mt-0.5">
            {session.branch}
            {session.dirty > 0 && ` · ${session.dirty}~`}
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * Shared session list panel — used inside both the desktop sidebar and the
 * mobile drawer so they stay perfectly in sync.
 *
 * @param props - Component props.
 * @param props.sessions - Sessions to render.
 * @param props.onFocus - Focus handler.
 * @param props.wsUrl - Live WS URL for the footer row.
 * @param props.connected - Connection state for the footer dot.
 * @returns The panel content (header, list, footer).
 */
function SessionPanel({
  sessions,
  onFocus,
  wsUrl,
  connected,
}: {
  sessions:  HubSession[];
  onFocus:   (sid: string) => void;
  wsUrl:     string;
  connected: boolean;
}) {
  return (
    <>
      <div className="px-6 pt-5 pb-2">
        <span className="text-muted-foreground/60 font-headline font-bold uppercase text-[10px] tracking-widest">
          Sessions
        </span>
      </div>
      <nav className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="px-6 py-4 text-xs font-mono text-muted-foreground/50 italic">
            No active sessions
          </p>
        ) : (
          sessions.map(s => (
            <SessionItem key={s.full} session={s} onFocus={onFocus} />
          ))
        )}
      </nav>
      {/* Footer shows the real runtime WS URL so mobile users can see the exact
          endpoint the page is trying to reach — invaluable for LAN-access debugging.
          wsUrl is empty during SSR to avoid a hydration mismatch. */}
      <div className="px-6 py-4 border-t border-border flex items-center gap-2 min-h-[2.75rem]">
        {wsUrl && (
          <>
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full flex-shrink-0',
                connected ? 'bg-green-500' : 'bg-red-500/70',
              )}
            />
            <span className="text-[9px] font-mono text-muted-foreground/40 tracking-tight truncate">
              {wsUrl}
            </span>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Sessions sidebar — mounts both the desktop aside and the mobile drawer.
 *
 * The drawer wraps `SessionPanel` with a backdrop; tapping either the
 * backdrop or a session row auto-closes the drawer so a selection always
 * returns the user to the main canvas.
 *
 * @param props - See {@link SidebarProps}.
 * @returns Desktop aside + conditional mobile drawer.
 */
export function Sidebar({
  sessions,
  onFocus,
  wsUrl,
  connected,
  mobileOpen = false,
  onClose,
}: SidebarProps) {
  return (
    <>
      {/* ── Desktop fixed sidebar (md+) ──────────────────────────────── */}
      <aside className="hidden md:flex fixed left-0 top-16 h-[calc(100vh-4rem)] w-64 flex-col bg-background border-r border-border z-40 overflow-hidden">
        <SessionPanel sessions={sessions} onFocus={onFocus} wsUrl={wsUrl} connected={connected} />
      </aside>

      {/* ── Mobile drawer ────────────────────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-[60] flex">
          {/* Drawer panel */}
          <aside className="flex flex-col w-72 max-w-[80vw] h-full bg-background border-r border-border shadow-2xl overflow-hidden">
            <SessionPanel
              sessions={sessions}
              onFocus={sid => { onFocus(sid); onClose?.(); }}
              wsUrl={wsUrl}
              connected={connected}
            />
          </aside>
          {/* Backdrop — tap to close */}
          <div
            className="flex-1 bg-background/60 backdrop-blur-sm"
            onClick={onClose}
          />
        </div>
      )}
    </>
  );
}
