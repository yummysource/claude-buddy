'use client';

/**
 * @file Terminal-style panel showing the latest assistant response.
 *
 * Renders `assistant_msg` as Markdown inside a mock terminal window. The hub
 * now preserves newlines in the assistant message (no more join-split collapse)
 * and applies smart fence-balanced truncation, so code blocks and lists render
 * correctly. `human_msg` is shown above as a plain-text quote under a "You:"
 * label; it intentionally stays plain because it is already a single-line
 * collapsed string.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatModel } from '@/lib/utils';
import type { HubHeartbeat } from '@/types/hub';

interface LatestReplyProps {
  /** Heartbeat — `assistant_msg`, `human_msg`, `model`, and `project`/`branch` are consumed. */
  hb: HubHeartbeat | null;
}

/**
 * Latest-response panel.
 *
 * The assistant message is rendered as GitHub-Flavoured Markdown so code
 * blocks, lists, bold/italic, and tables appear formatted. The human prompt
 * is shown first as a plain-text quote under a "You:" label.
 *
 * @param props - See {@link LatestReplyProps}.
 * @returns The terminal-framed panel.
 */
export function LatestReply({ hb }: LatestReplyProps) {
  const msg       = hb?.assistant_msg ?? null;
  const humanMsg  = hb?.human_msg ?? null;
  const model     = hb?.model ?? '';
  const prompt    = model ? `${formatModel(model).toLowerCase()}:~$` : 'claude:~$';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="font-headline font-bold text-sm tracking-[0.2em] text-foreground uppercase">
          Latest Response
        </h2>
        {hb?.started_at && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {hb.started_at}
          </span>
        )}
      </div>

      <div className="glass-panel rounded-xl border border-border/40 overflow-hidden">
        {/* Terminal title bar */}
        <div className="bg-surface-high/50 px-5 py-2.5 flex items-center gap-4 border-b border-border/40">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-destructive/35" />
            <div className="w-2.5 h-2.5 rounded-full bg-primary/35" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/35" />
          </div>
          <span className="text-[10px] font-mono text-muted-foreground">
            {hb?.project ? `${hb.project}` : 'claude-code'}
            {hb?.branch ? ` (${hb.branch})` : ''}
          </span>
        </div>

        {/* Content */}
        <div className="p-6 font-mono text-sm text-muted-foreground leading-relaxed min-h-[8rem] space-y-4">

          {/* User question block */}
          {humanMsg && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-2">
                You:
              </p>
              <div className="prose-buddy prose-buddy-human text-[11px] border-l-2 border-primary/30 pl-3">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {humanMsg}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {/* Model prompt + Markdown-rendered assistant reply */}
          <div>
            <p className="text-primary text-[11px] mb-3">{prompt}</p>
            {msg ? (
              <div className="prose-buddy text-[12px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-muted-foreground/40 italic text-xs">
                Waiting for response…
              </p>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
