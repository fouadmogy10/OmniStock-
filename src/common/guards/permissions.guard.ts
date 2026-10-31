import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Permission, PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
export { Permission, PERMISSIONS_KEY };

/**
 * Static Role-to-Permission Mapping Matrix (spec.md FR-002)
 */
export const ROLE_PERMISSIONS_MATRIX: Record<string, Permission[]> = {
  ADMIN: [
    Permission.TENANT_READ,
    Permission.USERS_READ,
    Permission.USERS_MANAGE,
    Permission.AUDIT_READ,
    Permission.CUSTOMERS_READ,
    Permission.CUSTOMERS_WRITE,
    Permission.CATEGORIES_READ,
    Permission.CATEGORIES_WRITE,
    Permission.PRODUCTS_READ,
    Permission.PRODUCTS_WRITE,
    Permission.WAREHOUSES_READ,
    Permission.WAREHOUSES_WRITE,
    Permission.INVENTORY_READ,
    Permission.INVENTORY_ADJUST,
    Permission.INVENTORY_THRESHOLD,
    Permission.MOVEMENTS_READ,
    Permission.TRANSFERS_READ,
    Permission.TRANSFERS_WRITE,
    Permission.TRANSFERS_EXECUTE,
    Permission.ORDERS_READ,
    Permission.ORDERS_WRITE,
    Permission.ORDERS_ALLOCATE,
    Permission.ORDERS_SHIP,
    Permission.ORDERS_CANCEL,
    Permission.ALERTS_READ,
    Permission.DASHBOARD_READ,
    Permission.SYNC_READ,
    Permission.SYNC_RETRY,
    Permission.SYNC_CREDENTIALS,
  ],
  MANAGER: [
    Permission.TENANT_READ,
    Permission.CUSTOMERS_READ,
    Permission.CUSTOMERS_WRITE,
    Permission.CATEGORIES_READ,
    Permission.CATEGORIES_WRITE,
    Permission.PRODUCTS_READ,
    Permission.PRODUCTS_WRITE,
    Permission.WAREHOUSES_READ,
    Permission.WAREHOUSES_WRITE,
    Permission.INVENTORY_READ,
    Permission.INVENTORY_ADJUST,
    Permission.INVENTORY_THRESHOLD,
    Permission.MOVEMENTS_READ,
    Permission.TRANSFERS_READ,
    Permission.TRANSFERS_WRITE,
    Permission.TRANSFERS_EXECUTE,
    Permission.ORDERS_READ,
    Permission.ORDERS_WRITE,
    Permission.ORDERS_ALLOCATE,
    Permission.ORDERS_SHIP,
    Permission.ORDERS_CANCEL,
    Permission.ALERTS_READ,
    Permission.DASHBOARD_READ,
    Permission.SYNC_READ,
    Permission.SYNC_RETRY,
  ],
  VIEWER: [
    Permission.TENANT_READ,
    Permission.CUSTOMERS_READ,
    Permission.CATEGORIES_READ,
    Permission.PRODUCTS_READ,
    Permission.WAREHOUSES_READ,
    Permission.INVENTORY_READ,
    Permission.MOVEMENTS_READ,
    Permission.TRANSFERS_READ,
    Permission.ORDERS_READ,
    Permission.ALERTS_READ,
    Permission.DASHBOARD_READ,
  ],
  SYSTEM_WORKER: [
    Permission.SYNC_READ,
    Permission.SYNC_RETRY,
    Permission.ORDERS_READ,
    Permission.ORDERS_WRITE,
    Permission.ORDERS_ALLOCATE,
    Permission.CUSTOMERS_READ,
    Permission.CUSTOMERS_WRITE,
    Permission.PRODUCTS_READ,
    Permission.WAREHOUSES_READ,
    Permission.INVENTORY_READ,
  ],
};

/**
 * PermissionsGuard
 *
 * Sole authoritative RBAC guard across the application (deny-by-default).
 * Evaluates the database-loaded User.role attached by TenantInterceptor.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no permission metadata is set, deny access by default unless explicitly public
    if (!requiredPermissions || requiredPermissions.length === 0) {
      throw new ForbiddenException({
        statusCode: 403,
        error_code: 'INSUFFICIENT_PERMISSIONS',
        message: 'Endpoint lacks required permission definition',
      });
    }

    const request = context.switchToHttp().getRequest();
    let authenticatedUser = request.authenticatedUser;

    // If request.authenticatedUser is not yet populated but JWT user exists, load authoritative role from DB
    if (!authenticatedUser && request.user?.tenant_id && request.user?.sub && this.dataSource) {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.query(`SET LOCAL app.current_tenant_id = '${request.user.tenant_id}';`);
        const [user] = await qr.query(
          `SELECT id, tenant_id, email, role, is_active FROM users WHERE id = $1 AND tenant_id = $2;`,
          [request.user.sub, request.user.tenant_id],
        );

        if (!user || !user.is_active) {
          throw new ForbiddenException({
            statusCode: 403,
            error_code: 'TENANT_MEMBERSHIP_REQUIRED',
            message: 'Active tenant membership required',
          });
        }

        authenticatedUser = {
          id: user.id,
          tenant_id: user.tenant_id,
          email: user.email,
          role: user.role,
          is_active: user.is_active,
        };
        request.authenticatedUser = authenticatedUser;
        await qr.commitTransaction();
      } catch (err) {
        await qr.rollbackTransaction();
        throw err;
      } finally {
        await qr.release();
      }
    }

    if (!authenticatedUser || !authenticatedUser.role) {
      throw new ForbiddenException({
        statusCode: 403,
        error_code: 'INSUFFICIENT_PERMISSIONS',
        message: 'Authenticated user context missing for RBAC evaluation',
      });
    }

    const userPermissions = ROLE_PERMISSIONS_MATRIX[authenticatedUser.role] || [];

    const hasAllPermissions = requiredPermissions.every((permission) =>
      userPermissions.includes(permission),
    );

    if (!hasAllPermissions) {
      throw new ForbiddenException({
        statusCode: 403,
        error_code: 'INSUFFICIENT_PERMISSIONS',
        message: 'Current database role does not grant required permission',
      });
    }

    return true;
  }
}
