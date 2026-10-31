import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

const REQUEST_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const rawHeader = req.headers['x-request-id'];
    let requestId: string;

    if (typeof rawHeader === 'string' && REQUEST_ID_REGEX.test(rawHeader.trim())) {
      requestId = rawHeader.trim();
    } else {
      requestId = randomUUID();
    }

    // Attach to request
    (req as any).requestId = requestId;

    // Echo on response header
    res.setHeader('X-Request-Id', requestId);

    next();
  }
}
