import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Request, Response } from 'express';
import { RateLimiterService } from '../services/rate-limiter.service';
import { resolveClientIp } from '../utils/client-ip.util';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly rateLimiterService: RateLimiterService) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const trustedProxyRaw = process.env.TRUSTED_PROXY_IPS || '';
    const trustedProxyIps = trustedProxyRaw
      .split(',')
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0);

    const clientIp = resolveClientIp(req, trustedProxyIps);
    const ttlSeconds = parseInt(process.env.RATE_LIMIT_TTL_SECONDS || '60', 10);

    const method = req.method.toUpperCase();
    const path = req.path || req.url;

    // 1. POST /tenants -> Onboarding Rate Limit
    if (method === 'POST' && (path === '/tenants' || path === '/tenants/')) {
      const maxOnboard = parseInt(process.env.RATE_LIMIT_TENANT_ONBOARD_MAX || '5', 10);
      const key = `tenant_onboard:ip:${clientIp}`;
      this.rateLimiterService.consumeOrThrow(key, maxOnboard, ttlSeconds, res);
      return true;
    }

    // 2. POST /auth/login -> Login Rate Limit
    if (method === 'POST' && (path === '/auth/login' || path === '/auth/login/')) {
      // Coarse per-IP ceiling
      const maxLoginIp = parseInt(process.env.RATE_LIMIT_LOGIN_IP_MAX || '30', 10);
      const ipKey = `login:ip:${clientIp}`;
      this.rateLimiterService.consumeOrThrow(ipKey, maxLoginIp, ttlSeconds, res);

      // Composite account-specific ceiling
      const body = req.body || {};
      const tenantSlug =
        typeof body.tenant_slug === 'string' ? body.tenant_slug.trim().toLowerCase() : 'unknown';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : 'unknown';
      const maxLoginAccount = parseInt(process.env.RATE_LIMIT_LOGIN_MAX || '10', 10);
      const accountKey = `login:account:${clientIp}:${tenantSlug}:${email}`;
      this.rateLimiterService.consumeOrThrow(accountKey, maxLoginAccount, ttlSeconds, res);
      return true;
    }

    // 3. POST /sync/webhook/:source -> Tier 1 Pre-Authentication Webhook Rate Limit
    if (method === 'POST' && path.includes('/sync/webhook/')) {
      const pathParts = path.split('/');
      const source = String(
        req.params?.source || pathParts[pathParts.indexOf('webhook') + 1] || 'unknown',
      ).toLowerCase();

      // Pre-auth IP ceiling
      const maxWebhookIp = parseInt(process.env.RATE_LIMIT_WEBHOOK_IP_MAX || '60', 10);
      const webhookIpKey = `webhook:preauth:ip:${clientIp}`;
      this.rateLimiterService.consumeOrThrow(webhookIpKey, maxWebhookIp, ttlSeconds, res);

      // Pre-auth source + IP ceiling
      const maxWebhookSourceIp = parseInt(
        process.env.RATE_LIMIT_WEBHOOK_SOURCE_IP_MAX || '120',
        10,
      );
      const webhookSourceIpKey = `webhook:preauth:source_ip:${source}:${clientIp}`;
      this.rateLimiterService.consumeOrThrow(
        webhookSourceIpKey,
        maxWebhookSourceIp,
        ttlSeconds,
        res,
      );

      return true;
    }

    return true;
  }
}
