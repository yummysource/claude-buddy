'use client';

/**
 * @file Mobile bottom navigation bar (hidden on `md`+ screens).
 *
 * Single Sessions button — horizontal icon + label layout, compact height.
 * Bottom padding uses `env(safe-area-inset-bottom)` so the tap target sits
 * above the iOS home indicator rather than inside its gesture strip.
 */

import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MobileNavProps {
  /** Whether the sessions drawer is currently open. Controls icon stroke + color. */
  open:     boolean;
  /** Called when the button is tapped — parent flips drawer state. */
  onToggle: () => void;
}

/**
 * Mobile-only bottom nav.
 *
 * Rendered unconditionally in the tree; visibility is purely CSS
 * (`md:hidden`) so the drawer state stays in sync across breakpoint changes.
 *
 * @param props - See {@link MobileNavProps}.
 * @returns The fixed bottom nav.
 */
export function MobileNav({ open, onToggle }: MobileNavProps) {
  return (
    <nav
      className={cn(
        'md:hidden fixed bottom-0 left-0 w-full z-50',
        'flex items-center justify-center',
        // Bottom padding accounts for the iOS home indicator (safe-area-inset-bottom)
        // so the button doesn't land in the system gesture zone at screen bottom.
        'px-6 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]',
        'bg-card border-t border-border',
        'shadow-[0_-4px_20px_rgba(0,0,0,0.08)]',
        'rounded-t-xl',
      )}
    >
      <button
        onClick={onToggle}
        className={cn(
          'flex flex-row items-center justify-center gap-2 py-1.5 px-5 rounded-lg',
          'transition-all active:scale-95 cursor-pointer touch-manipulation',
          open
            ? 'text-primary bg-primary/10'
            : 'text-muted-foreground/50',
        )}
      >
        <MessageSquare
          size={16}
          aria-hidden="true"
          strokeWidth={open ? 2.5 : 1.5}
        />
        <span className="font-headline text-[10px] font-bold tracking-[0.1em]">
          SESSIONS
        </span>
      </button>
    </nav>
  );
}
