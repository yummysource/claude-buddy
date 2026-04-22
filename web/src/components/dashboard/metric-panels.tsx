'use client';

/**
 * @file Three-column glassmorphism detail panels:
 *   1. Token Distribution — input / output / cache breakdown bars.
 *   2. Operator Approvals — approved / denied / failed counts.
 *   3. Code Changes       — lines inserted / deleted, plus top tool counts.
 *
 * The Code Changes panel distinguishes "no data yet" (`null`) from "zero
 * changes" (`0`): null renders an em-dash, 0 renders `+0` / `-0`. This
 * matters because a brand-new session hasn't run a diff yet — showing `+0`
 * would imply the diff was computed and came up empty.
 */

import type { ReactNode } from 'react';
import { formatTokens } from '@/lib/utils';
import type { HubHeartbeat } from '@/types/hub';

interface MetricPanelsProps {
  /** Full heartbeat; each sub-panel reads only the fields it needs. */
  hb: HubHeartbeat | null;
}

/**
 * Shared card chrome for all three panels — title band + content slot.
 *
 * @param props - Component props.
 * @param props.title - Uppercased heading displayed at the top of the card.
 * @param props.children - Panel body.
 * @returns A glass-panel card.
 */
function PanelShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="glass-panel p-6 rounded-xl border border-border/40">
      <h3 className="font-headline font-bold text-xs tracking-widest text-primary uppercase mb-6">
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * Labelled horizontal bar for token distribution.
 *
 * @param props - Component props.
 * @param props.label - Bar name (shown on the left).
 * @param props.value - Raw token count (displayed as a formatted number).
 * @param props.pct - Width of the filled region, 0–100.
 * @param props.color - Full Tailwind background class for the filled region.
 * @returns A label-above, bar-below row.
 */
function TokenBar({
  label,
  value,
  pct,
  color,
}: {
  label: string;
  value: number;
  pct: number;
  color: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-[10px] font-mono">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-primary font-bold">{formatTokens(value)}</span>
      </div>
      <div className="w-full h-2.5 bg-muted rounded-sm overflow-hidden">
        <div
          className={`${color} h-full transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Token distribution panel — input / output / cache breakdown as stacked bars.
 *
 * Uses `|| 1` on the denominator so an all-zero heartbeat divides cleanly
 * instead of producing `NaN%` widths.
 *
 * @param props - Component props.
 * @param props.hb - Heartbeat supplying token counts.
 * @returns The token distribution panel.
 */
function TokenPanel({ hb }: { hb: HubHeartbeat | null }) {
  const inp   = hb?.input_tokens  ?? 0;
  const out   = hb?.output_tokens ?? 0;
  const cache = hb?.cache_tokens  ?? 0;
  const total = inp + out + cache || 1;

  return (
    <PanelShell title="Token Distribution">
      <div className="space-y-5">
        <TokenBar label="INPUT"  value={inp}   pct={(inp   / total) * 100} color="bg-primary/80" />
        <TokenBar label="OUTPUT" value={out}   pct={(out   / total) * 100} color="bg-primary/40" />
        <TokenBar label="CACHE"  value={cache} pct={(cache / total) * 100} color="bg-muted-foreground/40" />
      </div>
    </PanelShell>
  );
}

/**
 * Single approval metric box — count + label + status dot.
 *
 * Each call site must pass the FULL Tailwind class strings (not interpolated)
 * so the Tailwind scanner picks them up as static literals at build time.
 * Passing something like `text-${color}` would silently render without color
 * in production.
 *
 * @param props - Component props.
 * @param props.count - Numeric value shown large.
 * @param props.label - Label shown small under the count.
 * @param props.colorClass - Full Tailwind text color class for the count.
 * @param props.labelClass - Full Tailwind text color class for the label.
 * @param props.dotClass - Full Tailwind background class for the status dot.
 * @returns A single centered stat box.
 */
function ApprovalBox({
  count,
  label,
  colorClass,
  labelClass,
  dotClass,
}: {
  count:      number;
  label:      string;
  /** Full Tailwind text color class for the count value, e.g. "text-primary". */
  colorClass: string;
  /** Full Tailwind text color class for the label, e.g. "text-primary/60". */
  labelClass: string;
  dotClass:   string;
}) {
  return (
    <div className="flex flex-col items-center justify-center p-4 bg-background rounded border border-border/40">
      <span className={`text-2xl font-mono font-bold mb-1 ${colorClass}`}>
        {count}
      </span>
      <span className={`text-[8px] font-headline tracking-widest uppercase ${labelClass}`}>
        {label}
      </span>
      <div className={`mt-2 w-1 h-1 rounded-full ${dotClass}`} />
    </div>
  );
}

/**
 * Operator approvals panel — three boxes: approved, denied, failed.
 *
 * @param props - Component props.
 * @param props.hb - Heartbeat supplying `approvals` / `denials` / `fail_count`.
 * @returns The approvals panel.
 */
function ApprovalsPanel({ hb }: { hb: HubHeartbeat | null }) {
  const approved = hb?.approvals  ?? 0;
  const denied   = hb?.denials    ?? 0;
  const failed   = hb?.fail_count ?? 0;
  const total    = approved + denied + failed;

  return (
    <PanelShell title="Operator Approvals">
      <div className="grid grid-cols-3 gap-3">
        <ApprovalBox
          count={approved} label="Approved"
          colorClass="text-primary"          labelClass="text-primary/60"
          dotClass="bg-primary shadow-[0_0_4px_#f2ca50]"
        />
        <ApprovalBox
          count={denied}   label="Denied"
          colorClass="text-destructive"      labelClass="text-destructive/60"
          dotClass="bg-destructive"
        />
        <ApprovalBox
          count={failed}   label="Failed"
          colorClass="text-muted-foreground" labelClass="text-muted-foreground/60"
          dotClass="bg-muted-foreground/40"
        />
      </div>
    </PanelShell>
  );
}

/**
 * Code Changes panel — two columns side by side.
 *
 * Left column: insertions (green) above deletions (red), each with a thin
 * progress bar scaled so the larger value fills 100%.
 * Right column: tool invocation counts sorted descending — all tools shown,
 * scrollable when the list is long.
 *
 * `?? null` preserves the "no data yet" (—) vs "zero changes" (+0) distinction.
 *
 * @param props - Component props.
 * @param props.hb - Heartbeat supplying `lines_added`, `lines_removed`, `tool_counts`.
 * @returns The Code Changes panel.
 */
function MutationPanel({ hb }: { hb: HubHeartbeat | null }) {
  const added   = hb?.lines_added   ?? null;
  const removed = hb?.lines_removed ?? null;
  const peak    = Math.max(added ?? 0, removed ?? 0, 1);
  const tools   = hb?.tool_counts ? Object.entries(hb.tool_counts).sort(([, a], [, b]) => b - a) : [];

  return (
    <PanelShell title="Code Changes">
      <div className="flex gap-4 min-h-0">

        {/* ── Left: insertions + deletions ── */}
        <div className="flex flex-col gap-4 flex-shrink-0 w-[44%]">
          {/* Insertions */}
          <div className="space-y-1.5">
            <div className={`text-2xl font-mono font-bold leading-none ${added !== null ? 'text-success' : 'text-muted-foreground/40'}`}>
              {added !== null ? `+${added.toLocaleString()}` : '—'}
            </div>
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-success rounded-full transition-all duration-500"
                style={{ width: added !== null ? `${(added / peak) * 100}%` : '0%' }}
              />
            </div>
            <div className="text-[8px] font-headline text-muted-foreground uppercase tracking-widest">
              Insertions
            </div>
          </div>

          {/* Deletions */}
          <div className="space-y-1.5">
            <div className={`text-2xl font-mono font-bold leading-none ${removed !== null ? 'text-destructive' : 'text-muted-foreground/40'}`}>
              {removed !== null ? `-${removed.toLocaleString()}` : '—'}
            </div>
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-destructive rounded-full transition-all duration-500"
                style={{ width: removed !== null ? `${(removed / peak) * 100}%` : '0%' }}
              />
            </div>
            <div className="text-[8px] font-headline text-muted-foreground uppercase tracking-widest">
              Deletions
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="w-px bg-border/60 self-stretch flex-shrink-0" />

        {/* ── Right: tool counts ── */}
        <div className="flex-1 min-w-0 overflow-y-auto max-h-32">
          {tools.length === 0 ? (
            <p className="text-[10px] font-mono text-muted-foreground/40 italic pt-1">
              No tool calls yet
            </p>
          ) : (
            <div className="space-y-1.5">
              {tools.map(([tool, count]) => (
                <div key={tool} className="flex items-center justify-between gap-2 text-[10px] font-mono">
                  <span className="text-muted-foreground truncate">{tool}</span>
                  <span className="text-primary font-bold tabular-nums flex-shrink-0">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </PanelShell>
  );
}

/**
 * Three-column detail panel row.
 *
 * Collapses to a single column on mobile; three columns from the `lg`
 * breakpoint up.
 *
 * @param props - See {@link MetricPanelsProps}.
 * @returns The three-panel grid.
 */
export function MetricPanels({ hb }: MetricPanelsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <TokenPanel     hb={hb} />
      <ApprovalsPanel hb={hb} />
      <MutationPanel  hb={hb} />
    </div>
  );
}
