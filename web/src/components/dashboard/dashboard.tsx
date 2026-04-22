'use client';

/**
 * @file Main dashboard client component.
 *
 * Owns the WebSocket hub connection and fans heartbeat state out into all
 * sub-components. Layout: fixed header (mt-16 on body compensates) + fixed
 * desktop sidebar + scrollable main canvas + fixed mobile bottom nav +
 * conditional approval modal on top.
 *
 * The header is `fixed` rather than `sticky` because iOS Safari's
 * `sticky + backdrop-blur` combination intermittently swallows touch events
 * on elements scrolled under it; `fixed` + explicit body margin avoids that.
 */

import { useState } from 'react';
import { useHub } from '@/hooks/use-hub';
import { useElapsed } from '@/hooks/use-elapsed';
import { formatDuration } from '@/lib/utils';
import { Header }         from './header';
import { Sidebar }        from './sidebar';
import { StatCards }      from './stat-cards';
import { MetricPanels }   from './metric-panels';
import { LatestReply }    from './latest-reply';
import { EventStream }    from './event-stream';
import { ApprovalModal }  from './approval-modal';
import { MobileNav }      from './mobile-nav';

/**
 * Top-level dashboard shell.
 *
 * Holds the hub connection and the mobile drawer open/closed state; every
 * other piece of UI is a stateless view driven by `heartbeat`.
 *
 * @returns The fully-assembled dashboard tree.
 */
export default function Dashboard() {
  const { heartbeat: hb, connected, wsUrl, authError, approve, deny, sendOption, focusSession } = useHub();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  // Live duration for the mobile status row. Header has its own copy of this —
  // sharing the hook keeps both tickers in lockstep without one owning the
  // other's render cycle.
  const elapsed = useElapsed(hb?.started_ts);

  return (
    <>
      {/* ── Sticky header ──────────────────────────────────────────────── */}
      <Header
        connected={connected}
        running={hb?.running    ?? 0}
        total={hb?.total        ?? 0}
        startedAt={hb?.started_at}
        startedTs={hb?.started_ts}
        branch={hb?.branch}
      />

      {/* ── Auth error banner ─────────────────────────────────────────────
          Pinned just under the fixed header. Surfaced only when the hub
          rejected our token (close code 4401); reconnecting won't help
          until the URL gains a valid ?token=... so we stop the spinner
          and tell the user how to recover. */}
      {authError && (
        <div className="fixed top-16 left-0 right-0 z-40 bg-destructive/10 border-b border-destructive/30 px-6 py-2 text-xs font-headline text-destructive text-center">
          Unauthorized — the hub rejected this connection.
          Check the <code className="font-mono">?token=</code> in the URL,
          or restart the hub without <code className="font-mono">--host</code>.
        </div>
      )}

      {/* ── Body layout (mt-16 clears the fixed header) ─────────────────── */}
      <div className="flex mt-16">

        {/* Desktop sidebar */}
        <Sidebar
          sessions={hb?.sessions ?? []}
          onFocus={focusSession}
          wsUrl={wsUrl}
          connected={connected}
          mobileOpen={mobileDrawerOpen}
          onClose={() => setMobileDrawerOpen(false)}
        />

        {/* Main canvas */}
        <main className="flex-1 md:ml-64 px-4 md:px-8 pt-6 pb-28 md:pb-10 space-y-8">

          {/* Mobile status row */}
          <div className="md:hidden flex flex-wrap items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500/70'}`}
              />
              <span className="text-[10px] font-headline font-bold uppercase tracking-widest text-muted-foreground/60">
                {connected ? 'System Live' : 'Disconnected'}
              </span>
              {/* Show the real WS URL when disconnected so phone users can see
                  what endpoint the page is actually trying to reach. wsUrl is
                  empty during SSR to avoid a hydration mismatch. */}
              {!connected && wsUrl && (
                <span className="text-[9px] font-mono text-muted-foreground/40 truncate">
                  · {wsUrl}
                </span>
              )}
            </div>
            <div className="flex gap-3 text-[10px] font-headline font-bold text-muted-foreground/60 tracking-wider">
              {hb?.started_at && <span>STARTED: {hb.started_at}</span>}
              {elapsed !== undefined && (
                <span className="text-primary/70">{formatDuration(elapsed)}</span>
              )}
              {hb?.branch && (
                <span className="text-primary/70">BRANCH: {hb.branch}</span>
              )}
            </div>
          </div>

          {/* Primary stat cards */}
          <StatCards hb={hb} />

          {/* Detail metric panels */}
          <MetricPanels hb={hb} />

          {/* Latest reply + event stream */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 items-start">
            <div className="xl:col-span-2">
              <LatestReply hb={hb} />
            </div>
            <div>
              <EventStream hb={hb} />
            </div>
          </div>

        </main>
      </div>

      {/* ── Mobile bottom nav ──────────────────────────────────────────── */}
      <MobileNav
        open={mobileDrawerOpen}
        onToggle={() => setMobileDrawerOpen(v => !v)}
      />

      {/* ── Approval overlay ───────────────────────────────────────────── */}
      <ApprovalModal
        hb={hb}
        onApprove={approve}
        onDeny={deny}
        onOption={sendOption}
      />
    </>
  );
}
