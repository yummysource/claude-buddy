'use client';

/**
 * @file Fixed top header — logo, live connection status, session counters,
 * branch badge, client-side duration ticker, and a three-mode theme toggle.
 *
 * The header is `fixed` (not `sticky`) to avoid an iOS Safari bug where
 * `sticky + backdrop-blur` intermittently eats touch events on the content
 * scrolled under it.
 */

import { useState, useEffect } from 'react';
import { useTheme } from 'next-themes';
import { Sun, Moon, Monitor, GitBranch } from 'lucide-react';
import { cn, formatDuration } from '@/lib/utils';
import { useElapsed } from '@/hooks/use-elapsed';

interface HeaderProps {
  /** True while the hub WebSocket is open. Drives the pulse dot and text copy. */
  connected:   boolean;
  /** Count of currently-running sessions. */
  running:     number;
  /** Total effective session count. */
  total:       number;
  /** Pre-formatted `"HH:MM"` start time of the focused session, if any. */
  startedAt?:  string;
  /** Focused-session start as Unix seconds — drives a live client-side duration ticker. */
  startedTs?:  number;
  /** Focused-session git branch; rendered as a pill when present. */
  branch?:     string;
}

/**
 * One button in the three-mode theme switcher.
 *
 * Uses a Lucide SVG icon rather than a Material Symbols glyph so the icon
 * never flashes unstyled while its font loads.
 *
 * @param props - Component props.
 * @param props.icon - Icon component to render.
 * @param props.label - Accessible label (also used as the tooltip).
 * @param props.active - Whether this mode is the currently-active theme.
 * @param props.onClick - Click handler (sets the theme).
 * @returns A single square icon button.
 */
function ThemeButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'flex items-center justify-center w-8 h-8 rounded transition-all active:scale-95 cursor-pointer touch-manipulation',
        active
          ? 'bg-primary/10 text-primary border border-primary/25'
          : 'text-muted-foreground hover:text-primary hover:bg-primary/5',
      )}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

/**
 * Top header bar.
 *
 * Maintains a client-side seconds ticker keyed on `startedTs` so the
 * duration updates every second without needing the server to push a
 * heartbeat for each tick. The ticker is reset (and its `setInterval`
 * recreated) whenever the focused session changes.
 *
 * @param props - See {@link HeaderProps}.
 * @returns The fixed header element.
 */
export function Header({
  connected,
  running,
  total,
  startedAt,
  startedTs,
  branch,
}: HeaderProps) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Live duration ticker — resets whenever the focused session changes.
  const elapsed = useElapsed(startedTs);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 flex justify-between items-center px-6 h-16 bg-background border-b border-border shadow-[0_1px_12px_rgba(0,0,0,0.08)]">

      {/* Left: logo + status */}
      <div className="flex items-center gap-6">
        <span className="text-lg font-bold tracking-[0.18em] text-primary drop-shadow-[0_0_8px_rgba(212,175,55,0.25)] font-headline uppercase select-none">
          CLAUDE BUDDY
        </span>

        {/* Live indicator + session counts */}
        <div className="hidden sm:flex items-center gap-3">
          <div className="relative flex h-2 w-2 flex-shrink-0">
            {connected && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            )}
            <span
              className={cn(
                'relative inline-flex rounded-full h-2 w-2',
                connected ? 'bg-green-500' : 'bg-red-500/70',
              )}
            />
          </div>
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider whitespace-nowrap flex items-center gap-1.5">
            {connected ? (
              <>
                {startedAt && (
                  <>
                    <span>STARTED:</span>
                    <span className="text-primary/80">{startedAt}</span>
                    <span className="text-muted-foreground/40">·</span>
                  </>
                )}
                {elapsed !== undefined && (
                  <>
                    <span className="text-primary/70">{formatDuration(elapsed)}</span>
                    <span className="text-muted-foreground/40">·</span>
                  </>
                )}
                <span className="text-primary/80">{total}</span>
                <span className="text-muted-foreground/50">{total === 1 ? 'SESSION' : 'SESSIONS'}</span>
                <span className="text-muted-foreground/40">·</span>
                {running > 0 ? (
                  <span className="text-green-500 font-bold">
                    {running > 1 ? `${running} ACTIVE` : 'ACTIVE'}
                  </span>
                ) : (
                  <span className="text-muted-foreground/50">IDLE</span>
                )}
                {branch && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="px-1.5 py-0.5 bg-primary/8 rounded border border-primary/15 text-primary/70 inline-flex items-center gap-1">
                      <GitBranch size={10} aria-hidden="true" />
                      {branch}
                    </span>
                  </>
                )}
              </>
            ) : (
              <span className="text-red-400/70">Disconnected</span>
            )}
          </span>
        </div>
      </div>

      {/* Right: theme toggle */}
      <div className="flex items-center gap-1 bg-surface-high/30 rounded-lg p-1 border border-border">
        <ThemeButton icon={Sun}     label="Light"  active={mounted && theme === 'light'}  onClick={() => setTheme('light')} />
        <ThemeButton icon={Moon}    label="Dark"   active={mounted && theme === 'dark'}   onClick={() => setTheme('dark')}  />
        <ThemeButton icon={Monitor} label="System" active={mounted && theme === 'system'} onClick={() => setTheme('system')} />
      </div>
    </header>
  );
}
