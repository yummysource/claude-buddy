import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

/**
 * Collect every non-internal IPv4 address on this machine so the dev server
 * transparently accepts requests from any host on the same LAN without
 * hand-maintaining a network-range whitelist.
 */
function localIPv4Addresses(): string[] {
  const ifaces = networkInterfaces();
  const addrs: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal) addrs.push(info.address);
    }
  }
  return addrs;
}

const nextConfig: NextConfig = {
  // Next.js 16 blocks cross-origin requests to the dev server (module scripts,
  // HMR WebSocket, RSC fetches). Allow this machine's own loopback + every
  // LAN IPv4 it currently exposes, so phone / same-LAN access Just Works.
  // Restart `bun run dev` after the network changes to re-pick-up IPs.
  allowedDevOrigins: ["127.0.0.1", ...localIPv4Addresses()],
};

export default nextConfig;
