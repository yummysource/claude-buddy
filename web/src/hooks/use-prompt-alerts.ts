'use client';

/**
 * @file Three-tier operator alerts for pending PreToolUse approvals.
 *
 * Drives notifications outside the dashboard's visual frame so a backgrounded
 * tab still reaches the operator before the hub's 30 s deny-on-timeout fires:
 *
 *   1. Tab title flash  (`document.title`)
 *   2. Web Notification (`Notification` API, requireInteraction)
 *   3. Audio beep       (`AudioContext`, repeats every 8 s)
 *
 * Permission and AudioContext setup both require a user gesture in modern
 * browsers, so the hook installs a one-shot `pointerdown` listener on first
 * mount to bootstrap them. Until the operator clicks anywhere on the page,
 * the second and third tiers degrade silently — the title flash always works.
 */

import { useEffect, useRef } from 'react';
import type { HubPrompt } from '@/types/hub';

const TITLE_FLASH_MS  = 1_000;
const AUDIO_REPEAT_MS = 8_000;
const BEEP_FREQ_HZ    = 880;
const BEEP_DURATION_S = 0.25;
const BEEP_PEAK_GAIN  = 0.18;

/**
 * Watch a pending prompt and fire title flash, browser notification, and
 * audio beep on transition.
 *
 * @param prompt - Current pending prompt from the heartbeat, or null/undefined
 *   when no approval is awaiting. Identity is keyed off `prompt.id`; a new id
 *   restarts every alert track, a null clears them.
 */
export function usePromptAlerts(prompt: HubPrompt | null | undefined): void {
  // Module-scoped via ref so beeps after the first share the same context
  // (creating new ones can fail under Chromium's per-page AudioContext cap).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const notifRef    = useRef<Notification | null>(null);

  // Bootstrap notification permission and the audio context on the first
  // user gesture — both APIs require one and silently fail otherwise.
  useEffect(() => {
    const bootstrap = (): void => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => { /* user dismissed */ });
      }
      if (!audioCtxRef.current) {
        try {
          audioCtxRef.current = new (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!)();
        } catch { /* AudioContext unsupported */ }
      }
    };
    document.addEventListener('pointerdown', bootstrap, { once: true });
    return () => document.removeEventListener('pointerdown', bootstrap);
  }, []);

  // Fire and maintain alerts while a prompt is pending.
  useEffect(() => {
    if (!prompt) return;

    const originalTitle = document.title;
    const flashTitle    = `🔔 ${prompt.tool} 等待批准…`;
    let   flashOn       = false;

    const titleTimer = window.setInterval(() => {
      flashOn = !flashOn;
      document.title = flashOn ? flashTitle : originalTitle;
    }, TITLE_FLASH_MS);

    beep(audioCtxRef.current);
    notifRef.current = showNotification(prompt);

    const audioTimer = window.setInterval(() => beep(audioCtxRef.current), AUDIO_REPEAT_MS);

    return () => {
      window.clearInterval(titleTimer);
      window.clearInterval(audioTimer);
      document.title = originalTitle;
      notifRef.current?.close();
      notifRef.current = null;
    };
    // Re-arm on a new prompt id; tool/hint changes are descriptive only.
  }, [prompt?.id, prompt?.tool, prompt?.hint]);
}

/**
 * Synthesize a short sine-wave beep. No-op when AudioContext is unavailable
 * or has not been resumed by a user gesture yet.
 *
 * @param ctx - Shared AudioContext, or null if bootstrap has not run.
 */
function beep(ctx: AudioContext | null): void {
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => { /* autoplay policy */ });
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = BEEP_FREQ_HZ;
    gain.gain.setValueAtTime(BEEP_PEAK_GAIN, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + BEEP_DURATION_S);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + BEEP_DURATION_S);
  } catch { /* context closed or oscillator quota hit */ }
}

/**
 * Pop a system notification for a pending prompt. Returns the Notification
 * instance so the caller can close it on cleanup.
 *
 * @param prompt - The prompt to surface.
 * @returns The Notification, or null if the API is unsupported / not granted.
 */
function showNotification(prompt: HubPrompt): Notification | null {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
  try {
    const n = new Notification('Claude Code 等待批准', {
      body:              `${prompt.tool} — ${prompt.hint}`,
      // Same tag across reissues so the OS replaces rather than stacks.
      tag:               'buddy-approval',
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return n;
  } catch {
    return null;
  }
}
