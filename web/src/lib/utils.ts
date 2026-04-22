/**
 * @file Small shared UI helpers: Tailwind class merging and value formatters.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class names, resolving conflicts so later classes win.
 *
 * Standard shadcn/ui helper: `clsx` handles truthy/conditional input, then
 * `twMerge` collapses duplicate utility families (e.g. two `px-*` become the
 * last one) so callers can safely layer defaults with overrides.
 *
 * @param inputs - Any mix of strings, arrays, and conditional objects.
 * @returns A deduplicated Tailwind class string.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a raw token count into a compact human-readable string.
 *
 * Why compact: the stat cards only have room for ~5 characters at the chosen
 * font size; exact counts would overflow on long sessions.
 *
 * @param n - Token count. Negative, NaN, or non-finite values fall back to `'0'`.
 * @returns `"1.2M"` for >=1e6, `"450K"` for >=1e3, otherwise the rounded integer.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}

/**
 * Format a wall-clock duration in seconds as `"Xh Ym"`, `"Xm Ys"`, or `"Xs"`.
 *
 * The format collapses from the largest non-zero unit so the header ticker
 * stays at a stable width once a session runs past one hour.
 *
 * @param secs - Duration in whole seconds. Fractional input is passed through
 *   to `Math.floor` via integer arithmetic.
 * @returns Short duration label, e.g. `"2h 14m"`, `"3m 05s"`, `"42s"`.
 */
export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Convert a raw Anthropic model identifier into a short display name.
 *
 * The regex strips any trailing date stamp and title-cases the family so the
 * UI shows "Sonnet 4.6" instead of the raw API slug. Unknown formats fall
 * back to the first two dash-separated segments after dropping the
 * `claude-` prefix, which keeps custom/unreleased names readable.
 *
 * @param model - Raw model slug from the hub, e.g. `"claude-sonnet-4-6"`.
 * @returns Short label like `"Sonnet 4.6"` / `"Opus 4.7"` / `"Haiku 4.5"`.
 * @example
 *   formatModel('claude-sonnet-4-6')         // "Sonnet 4.6"
 *   formatModel('claude-opus-4-7')           // "Opus 4.7"
 *   formatModel('claude-haiku-4-5-20251001') // "Haiku 4.5"
 */
export function formatModel(model: string): string {
  const m = model.toLowerCase();
  // Match family + version from the model slug
  const match = m.match(/(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  if (match) {
    const [, family, major, minor] = match;
    const version = minor ? `${major}.${minor}` : major;
    return `${family.charAt(0).toUpperCase() + family.slice(1)} ${version}`;
  }
  // Fallback: drop "claude-" prefix and title-case first word
  const parts = model.replace(/^claude-?/i, '').split('-');
  return parts.slice(0, 2).join(' ');
}

/**
 * Clamp a number to the inclusive range `[min, max]`.
 *
 * Used to keep percentage bars from overshooting 100% when the hub reports
 * tokens above the configured budget (edge case during model swaps).
 *
 * @param value - Input number.
 * @param min - Lower bound (inclusive).
 * @param max - Upper bound (inclusive).
 * @returns `value` constrained to the range. Passes `NaN` through unchanged
 *   because `Math.min`/`Math.max` short-circuit on NaN.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
