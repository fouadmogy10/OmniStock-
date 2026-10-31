import { Request } from 'express';

/**
 * Normalizes an IPv4 or IPv6 address (strips IPv4-mapped IPv6 prefix `::ffff:`).
 */
export function normalizeIp(ip?: string | null): string {
  if (!ip) return '127.0.0.1';
  let clean = ip.trim();
  if (clean.startsWith('::ffff:')) {
    clean = clean.substring(7);
  }
  return clean;
}

/**
 * Resolves trusted client IP per FR-020:
 * - If socket peer is NOT in TRUSTED_PROXY_IPS, X-Forwarded-For is completely ignored.
 * - If socket peer IS in TRUSTED_PROXY_IPS, hops in X-Forwarded-For are inspected from
 *   right to left, selecting the first IP that is NOT in TRUSTED_PROXY_IPS.
 */
export function resolveClientIp(req: Request, trustedProxyIps: string[] = []): string {
  const socketAddress = normalizeIp(req.socket?.remoteAddress);
  const normalizedTrusted = new Set(trustedProxyIps.map((ip) => normalizeIp(ip)));

  // If immediate connecting peer is not trusted, completely ignore X-Forwarded-For
  if (!normalizedTrusted.has(socketAddress)) {
    return socketAddress;
  }

  // Socket is trusted proxy, inspect X-Forwarded-For from right to left
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (!xForwardedFor) {
    return socketAddress;
  }

  const rawHops = typeof xForwardedFor === 'string' ? xForwardedFor : xForwardedFor[0];
  if (!rawHops || typeof rawHops !== 'string') {
    return socketAddress;
  }

  const hops = rawHops
    .split(',')
    .map((h) => normalizeIp(h))
    .filter((h) => h.length > 0);

  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (!normalizedTrusted.has(hop)) {
      return hop;
    }
  }

  return socketAddress;
}
