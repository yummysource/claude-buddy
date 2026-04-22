/**
 * @file Root page — renders the operator dashboard.
 *
 * The actual UI lives in the client component so that the WebSocket hook
 * (which touches `window` inside `useEffect`) only executes in the browser.
 * This file stays a server component so Next.js can still statically render
 * the outer shell.
 */

import Dashboard from '@/components/dashboard/dashboard';

/**
 * Single-route entry point for the operator dashboard.
 *
 * @returns The `Dashboard` client component which owns the hub connection.
 */
export default function Page() {
  return <Dashboard />;
}
