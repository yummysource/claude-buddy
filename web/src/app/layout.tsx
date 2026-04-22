/**
 * @file Root layout — loads fonts, wires up `ThemeProvider` and `TooltipProvider`.
 *
 * The three Google fonts are loaded via `next/font` so their `--font-*` CSS
 * variables are baked in at build time; Tailwind's `font-mono` / `font-headline`
 * families reference those variables in `globals.css`.
 */

import type { Metadata } from 'next';
import { Space_Grotesk, Inter, JetBrains_Mono } from 'next/font/google';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/components/theme-provider';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-space-grotesk',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-jetbrains',
});

export const metadata: Metadata = {
  title: 'CLAUDE BUDDY // Operator Dashboard',
  description: 'Real-time Claude Code session monitor',
};

/**
 * Viewport configuration exported separately so Next.js doesn't merge
 * conflicting defaults. `viewportFit: 'cover'` is what exposes the
 * `safe-area-inset-*` CSS env vars used by the mobile nav for the iOS
 * notch / home indicator.
 */
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/**
 * Next.js root layout — wraps every page with global providers.
 *
 * @param props - React props.
 * @param props.children - The active route's page tree.
 * @returns The full `<html>` / `<body>` shell with font variables applied.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}
      >
        <ThemeProvider>
          <TooltipProvider>
            {children}
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
