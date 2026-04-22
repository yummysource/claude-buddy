'use client';

/**
 * @file Shared live-ticker hook for session wall-clock duration.
 */

import { useState, useEffect } from 'react';

/**
 * Client-side ticker that returns seconds elapsed since `startedTs`.
 *
 * Returns `undefined` when no start time is known so the caller can hide
 * the element rather than render `"0s"`. Ticks every 1 s and resets when
 * `startedTs` changes — i.e. when the operator focuses a different
 * session, the clock restarts from that session's start.
 *
 * @param startedTs - Session start as Unix seconds. `undefined` / `0` disables the ticker.
 * @returns Elapsed whole seconds, or `undefined` when no start time is set.
 */
export function useElapsed(startedTs: number | undefined): number | undefined {
  const [elapsed, setElapsed] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!startedTs) {
      setElapsed(undefined);
      return;
    }
    const tick = () => setElapsed(Math.floor(Date.now() / 1000 - startedTs));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedTs]);

  return elapsed;
}
