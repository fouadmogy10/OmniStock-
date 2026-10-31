import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { DataSource } from 'typeorm';

export interface AuthenticatedUserContext {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  is_active: boolean;
}

/**
 * TenantInterceptor
 *
 * Implements transaction-scoped multi-tenant context propagation per FR-001 / FR-002:
 * 1. Derives tenant_id and user_id strictly from verified server-side JWT context (never client input).
 * 2. Sets `SET LOCAL app.current_tenant_id = '<tenant_uuid>'` inside the active transaction.
 * 3. Queries the active `User` row from `users` to verify active tenant membership independently
 *    of permission checks, attaching the database-loaded `User.role` to the request context.
 * 4. Fails closed when tenant context is absent, empty, or invalid.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly dataSource: DataSource) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();

    // Check if route is exempt from tenant context (e.g. public health probes or login)
    if (request.isTenantExempt) {
      return next.handle();
    }

    const jwtUser = request.user;
    if (!jwtUser || !jwtUser.tenant_id || !jwtUser.sub) {
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'AUTH_UNAUTHORIZED',
        message: 'Valid authenticated tenant token required',
      });
    }

    const tenantId = jwtUser.tenant_id;
    const userId = jwtUser.sub;

    // UUID format validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(tenantId) || !uuidRegex.test(userId)) {
      throw new ForbiddenException({
        statusCode: 403,
        error_code: 'TENANT_MEMBERSHIP_REQUIRED',
        message: 'Invalid tenant or user identifier in authentication context',
      });
    }

    // Verify tenant membership and active user status from database
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Transaction-scoped context propagation
      await queryRunner.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const [user] = await queryRunner.query(
        `SELECT id, tenant_id, email, role, is_active FROM users WHERE id = $1 AND tenant_id = $2;`,
        [userId, tenantId],
      );

      if (!user || !user.is_active) {
        throw new ForbiddenException({
          statusCode: 403,
          error_code: 'TENANT_MEMBERSHIP_REQUIRED',
          message: 'Active tenant membership required',
        });
      }

      // Attach verified database-loaded user context (sole authoritative role source)
      request.authenticatedUser = {
        id: user.id,
        tenant_id: user.tenant_id,
        email: user.email,
        role: user.role,
        is_active: user.is_active,
      };
      request.tenantId = user.tenant_id;

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }

    return next.handle();
  }
}
