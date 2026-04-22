'use client';

/**
 * @file PreToolUse approval overlay.
 *
 * Renders as a full-screen backdrop with a central card whenever `hb.prompt`
 * is populated. Dispatches `approve` / `deny` / `option` commands back to the
 * hub. The overlay uses proper ARIA dialog semantics (`role="dialog"`,
 * `aria-modal`, a titled heading) and wires Escape to `deny` — the prompt is
 * intentionally non-dismissible without a decision, so there is no "close
 * without answering" path.
 */

import { useEffect } from 'react';
import { Shield, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { HubHeartbeat, HubPrompt } from '@/types/hub';

interface ApprovalModalProps {
  /** Full heartbeat; modal is visible iff `hb.prompt` is non-null. */
  hb:          HubHeartbeat | null;
  /** Approve the prompt with the given ID. */
  onApprove:   (id: string) => void;
  /** Deny the prompt with the given ID (also fired by Escape). */
  onDeny:      (id: string) => void;
  /** Pick option `index` from a multi-choice prompt. */
  onOption:    (id: string, index: number) => void;
}

/**
 * The actual modal card — header, session badges, hint, preview, action row.
 *
 * Multi-choice prompts (`options.length > 0`) render one button per option
 * and suppress the Approve/Deny row; binary prompts render the standard
 * Approve/Deny pair.
 *
 * @param props - Component props.
 * @param props.prompt - The pending prompt to render.
 * @param props.onApprove - Approve handler.
 * @param props.onDeny - Deny handler.
 * @param props.onOption - Multi-choice option handler (index is 0-based).
 * @returns The dialog card (no backdrop — supplied by the parent).
 */
function ApprovalCard({
  prompt,
  onApprove,
  onDeny,
  onOption,
}: {
  prompt:    HubPrompt;
  onApprove: (id: string) => void;
  onDeny:    (id: string) => void;
  onOption:  (id: string, index: number) => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
      className={cn(
        'relative w-full max-w-lg mx-4',
        'bg-card border border-primary/30 rounded-xl shadow-2xl',
        'gilded-glow overflow-hidden',
      )}
      onClick={e => e.stopPropagation()}
    >
      {/* Top accent line */}
      <div className="h-0.5 w-full bg-gradient-to-r from-transparent via-primary/60 to-transparent" />

      <div className="p-8">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-headline font-bold tracking-widest text-muted-foreground uppercase">
              Operator Approval Required
            </span>
            <h2
              id="approval-title"
              className="text-lg font-headline font-bold text-foreground uppercase tracking-tight"
            >
              {prompt.tool}
            </h2>
          </div>
          <Shield size={22} className="text-primary/60" aria-hidden="true" />
        </div>

        {/* Session info badge */}
        {(prompt.sid || prompt.project) && (
          <div className="flex gap-2 mb-5 flex-wrap">
            {prompt.sid && (
              <span className="px-2 py-0.5 text-[10px] font-mono bg-muted text-muted-foreground rounded border border-border">
                [{prompt.sid}]
              </span>
            )}
            {prompt.project && (
              <span className="px-2 py-0.5 text-[10px] font-mono bg-primary/8 text-primary/70 rounded border border-primary/15">
                {prompt.project}
              </span>
            )}
          </div>
        )}

        {/* Hint */}
        <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
          {prompt.hint}
        </p>

        {/* Body */}
        {prompt.body && (
          <div className="mb-6 p-4 bg-background rounded border border-border overflow-auto max-h-40">
            <pre className="text-xs font-mono text-muted-foreground/80 whitespace-pre-wrap break-words">
              {prompt.body}
            </pre>
          </div>
        )}

        {/* Option buttons (multi-choice prompts) */}
        {prompt.options && prompt.options.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {prompt.options.map((opt, i) => (
              <button
                key={opt}
                onClick={() => onOption(prompt.id, i)}
                className={cn(
                  'px-4 py-2 text-xs font-headline tracking-widest uppercase rounded',
                  'border border-primary/30 text-primary',
                  'hover:bg-primary/10 transition-colors active:scale-95',
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        ) : (
          /* Approve / Deny */
          <div className="flex gap-3">
            <button
              onClick={() => onApprove(prompt.id)}
              className={cn(
                'flex-1 py-2.5 text-sm font-headline font-bold tracking-widest uppercase rounded',
                'bg-primary text-primary-foreground',
                'hover:bg-primary/90 transition-colors active:scale-95',
              )}
            >
              <Check size={14} className="inline mr-1" aria-hidden="true" />
              Approve
            </button>
            <button
              onClick={() => onDeny(prompt.id)}
              className={cn(
                'flex-1 py-2.5 text-sm font-headline font-bold tracking-widest uppercase rounded',
                'border border-destructive/40 text-destructive',
                'hover:bg-destructive/10 transition-colors active:scale-95',
              )}
            >
              <X size={14} className="inline mr-1" aria-hidden="true" />
              Deny
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Approval overlay entry point.
 *
 * Returns `null` when no prompt is pending so the overlay is completely
 * absent from the DOM (no stray `pointer-events: none` layer blocking
 * clicks). When a prompt arrives, renders a full-screen backdrop with the
 * `ApprovalCard` centered on top.
 *
 * @param props - See {@link ApprovalModalProps}.
 * @returns The overlay, or `null` when no prompt is pending.
 */
export function ApprovalModal({ hb, onApprove, onDeny, onOption }: ApprovalModalProps) {
  const prompt = hb?.prompt;

  // Deny via Escape key — intentionally not dismissible without a decision.
  useEffect(() => {
    if (!prompt) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDeny(prompt.id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [prompt, onDeny]);

  if (!prompt) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 backdrop-blur-sm cursor-default"
      aria-hidden="false"
    >
      <ApprovalCard
        prompt={prompt}
        onApprove={onApprove}
        onDeny={onDeny}
        onOption={onOption}
      />
    </div>
  );
}
