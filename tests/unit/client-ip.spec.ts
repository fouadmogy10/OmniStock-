import { Request } from 'express';
import { resolveClientIp, normalizeIp } from '../../src/common/utils/client-ip.util';

describe('Trusted Client IP Resolution Unit Tests (T074, FR-020)', () => {
  const createMockRequest = (remoteAddress: string, xForwardedFor?: string | string[]): Request => {
    return {
      socket: {
        remoteAddress,
      },
      headers: {
        ...(xForwardedFor ? { 'x-forwarded-for': xForwardedFor } : {}),
      },
    } as unknown as Request;
  };

  it('normalizes IPv4-mapped IPv6 address', () => {
    expect(normalizeIp('::ffff:192.168.1.50')).toBe('192.168.1.50');
    expect(normalizeIp('10.0.0.1')).toBe('10.0.0.1');
  });

  describe('When immediate socket peer is NOT in TRUSTED_PROXY_IPS', () => {
    const trustedProxies = ['10.0.0.1', '10.0.0.2'];

    it('ignores client-supplied X-Forwarded-For completely and returns socket remoteAddress', () => {
      const untrustedPeer = '198.51.100.5';
      const fakeClientIp = '203.0.113.195';

      const req = createMockRequest(untrustedPeer, fakeClientIp);
      const resolved = resolveClientIp(req, trustedProxies);

      expect(resolved).toBe(untrustedPeer);
    });

    it('ignores multiple spoofed hops in X-Forwarded-For', () => {
      const untrustedPeer = '198.51.100.5';
      const fakeHops = '203.0.113.1, 203.0.113.2, 10.0.0.1';

      const req = createMockRequest(untrustedPeer, fakeHops);
      const resolved = resolveClientIp(req, trustedProxies);

      expect(resolved).toBe(untrustedPeer);
    });
  });

  describe('When immediate socket peer IS in TRUSTED_PROXY_IPS', () => {
    const trustedProxies = ['10.0.0.1', '10.0.0.2'];

    it('resolves rightmost non-trusted hop from X-Forwarded-For', () => {
      // Chain: client -> proxy2 -> proxy1 -> server
      // X-Forwarded-For: client, proxy2
      // Socket: proxy1
      const clientIp = '203.0.113.50';
      const xForwardedFor = `${clientIp}, 10.0.0.2`;

      const req = createMockRequest('10.0.0.1', xForwardedFor);
      const resolved = resolveClientIp(req, trustedProxies);

      expect(resolved).toBe(clientIp);
    });

    it('correctly resolves first untrusted hop when multiple trusted proxies are in chain', () => {
      const clientIp = '198.51.100.99';
      const xForwardedFor = `1.2.3.4, ${clientIp}, 10.0.0.1, 10.0.0.2`;

      const req = createMockRequest('10.0.0.1', xForwardedFor);
      const resolved = resolveClientIp(req, trustedProxies);

      expect(resolved).toBe(clientIp);
    });

    it('falls back to socket address when X-Forwarded-For is missing or empty', () => {
      const req = createMockRequest('10.0.0.1');
      const resolved = resolveClientIp(req, trustedProxies);

      expect(resolved).toBe('10.0.0.1');
    });

    it('falls back to socket address when all hops in X-Forwarded-For are trusted proxies', () => {
      const xForwardedFor = '10.0.0.2, 10.0.0.1';
      const req = createMockRequest('10.0.0.1', xForwardedFor);
      const resolved = resolveClientIp(req, trustedProxies);

      expect(resolved).toBe('10.0.0.1');
    });
  });
});
