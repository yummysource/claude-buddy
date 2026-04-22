'use client';

/**
 * @file Chronological event waterfall showing recent hub hook entries.
 *
 * Entry strings come from `BuddyHub._transcript` (a deque of pre-formatted
 * strings). Each raw entry is parsed into `{ time, body, kind }` and color
 * coded by kind so the operator can scan for errors without reading every
 * line.
 */

import { cn } from '@/lib/utils';
import type { HubHeartbeat } from '@/types/hub';

interface EventStreamProps {
  /** Heartbeat whose `entries` array drives the timeline. */
  hb: HubHeartbeat | null;
}

interface ParsedEntry {
  /** Timestamp portion (`"HH:MM"` or `"HH:MM:SS"`); empty string when no match. */
  time: string;
  /** Message body — either the capture group or the whole raw string on parse miss. */
  body: string;
  /** Visual category assigned by substring heuristics on the body. */
  kind: 'error' | 'warning' | 'success' | 'approval' | 'default';
}

/**
 * Parse a raw transcript line from the hub.
 *
 * Expected format matches what `BuddyHub._append_transcript` produces:
 * `"HH:MM body"` or `"HH:MM:SS body"`. When the regex fails the whole input
 * is kept as the body and `time` stays empty — the caller simply skips the
 * timestamp row in that case rather than erroring out.
 *
 * @param raw - Raw transcript string from `HubHeartbeat.entries`.
 * @returns Parsed fields: `time`, `body`, and a heuristic `kind` used to pick
 *   the dot and label color.
 */
function parseEntry(raw: string): ParsedEntry {
  const match = raw.match(/^(\d{2}:\d{2}(?::\d{2})?)\s+(.+)$/);
  const time  = match ? match[1] : '';
  const body  = match ? match[2] : raw;

  const lower = body.toLowerCase();
  let kind: ParsedEntry['kind'] = 'default';

  if (lower.includes('error') || lower.includes('fail') || lower.includes('denied')) {
    kind = 'error';
  } else if (lower.includes('warn')) {
    kind = 'warning';
  } else if (lower.includes('approv') || lower.includes('success') || lower.includes('passed')) {
    kind = 'success';
  } else if (lower.includes('tool') || lower.includes('bash') || lower.includes('read')) {
    kind = 'approval';
  }

  return { time, body, kind };
}

const KIND_STYLES = {
  error:    { dot: 'bg-destructive',      label: 'text-destructive',        border: 'border-l-2 border-l-destructive' },
  warning:  { dot: 'bg-primary',          label: 'text-primary',            border: '' },
  success:  { dot: 'bg-green-500',        label: 'text-green-500',          border: '' },
  approval: { dot: 'bg-primary/60',       label: 'text-primary/80',         border: '' },
  default:  { dot: 'bg-muted-foreground/40', label: 'text-muted-foreground', border: '' },
} as const;

/**
 * Event timeline panel.
 *
 * Displays up to the 10 newest entries as a vertical timeline with colored
 * dots, grouped by parsed `kind`. Empty state shows a placeholder line so
 * the panel height stays stable as events arrive.
 *
 * @param props - See {@link EventStreamProps}.
 * @returns The event stream section.
 */
export function EventStream({ hb }: EventStreamProps) {
  const entries = hb?.entries ?? [];
  // Hub emits entries newest-first (index 0 is the most recent).
  // Display in the same order — newest at the top — so new events appear
  // immediately without the user having to scroll down.
  const recent = entries.slice(0, 10);

  return (
    <div className="space-y-3">
      <div className="px-1">
        <h2 className="font-headline font-bold text-sm tracking-[0.2em] text-foreground uppercase">
          Event Stream
        </h2>
      </div>

      {/* Timeline */}
      <div
        className="relative space-y-3 before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-border"
      >
        {recent.length === 0 ? (
          <p className="pl-8 text-xs font-mono text-muted-foreground/40 italic py-2">
            No events yet
          </p>
        ) : (
          recent.map((raw, idx) => {
            const { time, body, kind } = parseEntry(raw);
            const styles = KIND_STYLES[kind];
            // Newest-first: idx 0 is always the latest event, so positional
            // keys are not stable across updates. Combining idx with a slice
            // of the raw string gives a unique key with no duplicate risk.
            const key = `${idx}:${raw.slice(0, 40)}`;
            return (
              <div key={key} className="relative pl-8 group">
                {/* Timeline dot */}
                <div
                  className={cn(
                    'absolute left-1.5 top-2 w-3 h-3 rounded-full border-4 border-background',
                    styles.dot,
                    idx === 0 && 'group-hover:scale-125 transition-transform',
                  )}
                />
                {/* Timestamp */}
                {time && (
                  <div className="text-[10px] font-mono text-muted-foreground/60 mb-1">
                    {time}
                  </div>
                )}
                {/* Body */}
                <div
                  className={cn(
                    'p-2.5 bg-card rounded border border-border/40',
                    'hover:border-primary/20 transition-colors',
                    styles.border,
                  )}
                >
                  <p className={cn('text-xs font-mono leading-snug', styles.label)}>
                    {body}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
