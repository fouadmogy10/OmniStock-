import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuditLogService } from '../../modules/audit/audit.service';

/**
 * JwtAuthGuard
 *
 * Implements centralized JWT authentication guard per FR-001, FR-002, and T007:
 * - Allows public routes marked with @Public().
 * - Verifies Bearer JWT tokens using JwtService.
 * - Records pre-authentication security audit logs on invalid/expired tokens via `recordPreAuthAudit`.
 * - Rejects missing, invalid, or expired tokens with `401 Unauthorized` (`AUTH_UNAUTHORIZED`).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();

    if (isPublic) {
      request.isTenantExempt = true;
      return true;
    }

    const authHeader = request.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') {
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'AUTH_UNAUTHORIZED',
        message: 'Missing or malformed Authorization header',
      });
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'AUTH_UNAUTHORIZED',
        message: 'Invalid authorization scheme; Bearer token required',
      });
    }

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET,
      });

      request.user = payload;
      return true;
    } catch (err: any) {
      const clientIp = request.headers['x-forwarded-for'] || request.socket.remoteAddress;
      const userAgent = request.headers['user-agent'] || 'unknown';

      // Record pre-authentication failure in audit logs (tenant_id IS NULL)
      try {
        await this.auditLogService.recordPreAuthAudit('AUTH_TOKEN_INVALID', {
          error: err.name || 'TokenVerificationError',
          message: err.message,
          ip: String(clientIp),
          user_agent: String(userAgent),
        });
      } catch (auditErr) {
        this.logger.warn(`Failed to record pre-auth audit for invalid JWT: ${auditErr}`);
      }

      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'AUTH_UNAUTHORIZED',
        message: 'Invalid or expired authentication token',
      });
    }
  }
}
