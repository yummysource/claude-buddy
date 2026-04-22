'use client';

/**
 * @file Thin wrapper around `next-themes` ThemeProvider.
 *
 * Applies the active theme via a `class` attribute on `<html>`, which is what
 * Tailwind v4's `darkMode: "class"` variant keys off. `disableTransitionOnChange`
 * is enabled so the initial dark → system flip (when the OS prefers light)
 * doesn't animate every element on page load.
 */

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ComponentProps } from 'react';

type Props = ComponentProps<typeof NextThemesProvider>;

/**
 * Application-wide theme root.
 *
 * Defaults to `dark` because the dashboard's gilded-glow palette is designed
 * for the dark theme; the light theme is secondary. `enableSystem` means
 * users can still follow their OS preference if they pick "System" in the
 * header toggle. Any prop accepted by `next-themes` can be passed through.
 *
 * @param props - Forwarded to `next-themes`; `children` is required and
 *   receives the themed subtree.
 * @returns The theme-provider-wrapped subtree.
 */
export function ThemeProvider({ children, ...props }: Props) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
