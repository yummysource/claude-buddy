'use client';

/**
 * @file Four-column primary stat cards: context usage, active model, cache
 * hit rate, session cost.
 *
 * The Context Usage card applies two thresholds that are meaningful to the
 * operator: at 50% the bar goes yellow (time to plan the next compaction),
 * at 70% it goes red with a warning label (risk of hitting the budget
 * mid-response).
 */

import type { ReactNode, ElementType } from 'react';
import { Cpu, Brain, Zap, DollarSign } from 'lucide-react';
import { cn, formatModel, formatTokens, clamp } from '@/lib/utils';
import type { HubHeartbeat } from '@/types/hub';

interface StatCardsProps {
  /** Full heartbeat; each sub-card reads only the fields it needs. */
  hb: HubHeartbeat | null;
}

/**
 * Shared card frame — header row with label + icon, plus a content slot.
 *
 * `accentClass` is pulled out of `className` so callers can override the
 * default primary left border without losing `gilded-glow` and other shared
 * styling.
 *
 * @param props - Component props.
 * @param props.label - Uppercased stat name.
 * @param props.icon - Lucide icon component (avoids the Material Symbols font dependency).
 * @param props.children - Card body.
 * @param props.accentClass - Optional override for the left-border accent class.
 * @param props.className - Extra classes merged onto the outer div.
 * @returns A stat card shell.
 */
function StatCard({
  label,
  icon: Icon,
  children,
  accentClass,
  className,
}: {
  label: string;
  icon: ElementType;
  children: ReactNode;
  accentClass?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-card p-5 rounded-lg border border-border gilded-glow',
        'relative overflow-hidden group',
        accentClass ?? 'border-l-2 border-l-primary/60',
        className,
      )}
    >
      <div className="flex justify-between items-start mb-4">
        <span className="font-headline font-bold text-[10px] tracking-[0.2em] text-primary uppercase">
          {label}
        </span>
        <Icon size={14} className="text-primary/60" aria-hidden="true" />
      </div>
      {children}
    </div>
  );
}

/**
 * Context Usage card.
 *
 * Percentage source priority:
 *  1. `context_pct` — Claude Code's own pre-computed value delivered via the
 *     `statusline` hook. Always accurate, no estimation needed.
 *  2. `tokens / budget × 100` — fallback before the first statusline fires.
 *
 * Thresholds (percentage of context window consumed):
 * - `< 50%` → primary color (safe).
 * - `50% – < 70%` → yellow (warning, plan ahead).
 * - `>= 70%` → destructive red + "near capacity" label (imminent budget hit).
 *
 * @param props - Component props.
 * @param props.hb - Heartbeat supplying `context_pct`, `tokens`, and `budget`.
 * @returns The Context Usage stat card.
 */
function ContextCard({ hb }: { hb: HubHeartbeat | null }) {
  const budget   = hb?.budget ?? 200_000;
  const tokens   = hb?.tokens ?? 0;
  // Prefer the official percentage from the statusline hook; fall back to
  // computing it from tokens/budget when statusline hasn't fired yet.
  const pct      = hb?.context_pct != null
    ? clamp(hb.context_pct, 0, 100)
    : (budget > 0 ? clamp(Math.round((tokens / budget) * 100), 0, 100) : 0);
  const warning  = pct >= 50 && pct < 70;
  const critical = pct >= 70;

  const barColor = critical
    ? 'bg-destructive error-glow'
    : warning
      ? 'bg-yellow-400'
      : 'bg-primary/70';

  const valueColor = critical
    ? 'text-destructive'
    : warning
      ? 'text-yellow-500'
      : 'text-foreground';

  return (
    <StatCard
      label="Context Usage"
      icon={Cpu}
      accentClass={
        critical ? 'border-l-2 border-l-destructive'
        : warning  ? 'border-l-2 border-l-yellow-400'
        : undefined
      }
    >
      <div className="flex items-baseline gap-2 mb-3">
        <span className={cn('text-3xl font-mono font-bold', valueColor)}>
          {pct}%
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          / {formatTokens(budget)}
        </span>
      </div>
      <div className="w-full bg-muted h-1.5 rounded-full overflow-hidden">
        <div
          className={cn('h-full transition-all duration-500 rounded-full', barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {critical && (
        <div className="mt-2 text-[9px] font-mono text-destructive uppercase tracking-tighter">
          Warning: near capacity
        </div>
      )}
      {warning && (
        <div className="mt-2 text-[9px] font-mono text-yellow-500 uppercase tracking-tighter">
          Warning: high usage
        </div>
      )}
    </StatCard>
  );
}

/**
 * Active model card — shows the short model name and its source tag.
 *
 * @param props - Component props.
 * @param props.hb - Heartbeat supplying `model` and `source`.
 * @returns The Model stat card.
 */
function ModelCard({ hb }: { hb: HubHeartbeat | null }) {
  const name = hb?.model ? formatModel(hb.model) : '—';
  return (
    <StatCard label="Active Model" icon={Brain}>
      <div className="flex flex-col">
        <span className="text-xl font-headline font-bold text-foreground">
          {name}
        </span>
        <span className="text-[10px] text-primary/60 font-mono mt-1 uppercase tracking-widest">
          {hb?.source ?? 'claude code'}
        </span>
      </div>
      <div className="mt-5 flex gap-1">
        <div className="w-1.5 h-1.5 rounded-full bg-primary" />
        <div className="w-1.5 h-1.5 rounded-full bg-primary/40" />
        <div className="w-1.5 h-1.5 rounded-full bg-primary/10" />
      </div>
    </StatCard>
  );
}

/**
 * Cache hit rate card — percentage of input tokens that were cache reads.
 *
 * @param props - Component props.
 * @param props.hb - Heartbeat supplying `cache_pct`.
 * @returns The Cache Hit Rate stat card.
 */
function CacheCard({ hb }: { hb: HubHeartbeat | null }) {
  const pct = Math.round(hb?.cache_pct ?? 0);
  return (
    <StatCard label="Cache Hit Rate" icon={Zap}>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-mono font-bold text-primary">{pct}%</span>
      </div>
      <div className="mt-6 flex items-center gap-2">
        <div className="flex-1 bg-muted h-1 rounded-full overflow-hidden">
          <div
            className="bg-primary h-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </StatCard>
  );
}

/**
 * Session cost card — USD spend plus a subline with the total token count.
 *
 * Uses `hb?.tokens != null` (not truthiness) so a legitimate `0` still
 * renders as "Tokens: 0" rather than falling back to "No data".
 *
 * @param props - Component props.
 * @param props.hb - Heartbeat supplying `cost_usd` and `tokens`.
 * @returns The Session Cost stat card.
 */
function CostCard({ hb }: { hb: HubHeartbeat | null }) {
  const cost = hb?.cost_usd ?? 0;
  return (
    <StatCard label="Session Cost" icon={DollarSign}>
      <div className="flex items-baseline gap-1">
        <span className="text-3xl font-mono font-bold text-foreground">
          ${cost.toFixed(2)}
        </span>
      </div>
      <div className="mt-6 text-[10px] font-mono text-muted-foreground uppercase">
        {hb?.tokens != null
          ? <>Tokens: <span className="text-primary">{formatTokens(hb.tokens)}</span></>
          : 'No data'}
      </div>
    </StatCard>
  );
}

/**
 * Four-column primary stat row.
 *
 * Collapses to one column on phones, two columns from `sm`, and four from
 * `lg` so the cards always read left-to-right without wrapping mid-label.
 *
 * @param props - See {@link StatCardsProps}.
 * @returns The stat cards grid.
 */
export function StatCards({ hb }: StatCardsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <ContextCard hb={hb} />
      <ModelCard   hb={hb} />
      <CacheCard   hb={hb} />
      <CostCard    hb={hb} />
    </div>
  );
}
