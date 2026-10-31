import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

@Injectable()
export class RateLimiterService {
  private readonly hits = new Map<string, number[]>();

  checkLimit(
    key: string,
    maxRequests: number,
    ttlSeconds: number,
  ): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const windowMs = ttlSeconds * 1000;
    const windowStart = now - windowMs;

    let timestamps = this.hits.get(key) || [];
    // Prune expired timestamps
    timestamps = timestamps.filter((t) => t > windowStart);

    if (timestamps.length >= maxRequests) {
      const earliest = timestamps[0];
      const retryAfter = Math.max(1, Math.ceil((earliest + windowMs - now) / 1000));
      this.hits.set(key, timestamps);
      return { allowed: false, retryAfter };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfter: 0 };
  }

  consumeOrThrow(key: string, maxRequests: number, ttlSeconds: number, res?: Response): void {
    const result = this.checkLimit(key, maxRequests, ttlSeconds);
    if (!result.allowed) {
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('Retry-After', result.retryAfter.toString());
      }
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error_code: 'RATE_LIMIT_EXCEEDED',
          message: 'Rate limit exceeded, please retry later',
          retry_after: result.retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  reset(): void {
    this.hits.clear();
  }
}
