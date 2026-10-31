import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PermissionsGuard } from '../../src/common/guards/permissions.guard';
import { Permission, PERMISSIONS_KEY } from '../../src/common/decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';

dotenv.config();

describe('RBAC Permissions & Tenant Membership Integration Tests (T057)', () => {
  let appDs: DataSource;
  let guard: PermissionsGuard;
  let reflector: Reflector;

  const tenantId = 'a0000000-0000-0000-0000-000000000001';
  const adminUserId = '10000000-0000-0000-0000-000000000001';
  const managerUserId = '10000000-0000-0000-0000-000000000002';
  const viewerUserId = '10000000-0000-0000-0000-000000000003';
  const inactiveUserId = '10000000-0000-0000-0000-000000000004';

  beforeAll(async () => {
    appDs = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'omnistock',
      username: process.env.DB_APP_USER || 'omnistock_app',
      password: process.env.DB_APP_PASSWORD || 'AppSecurePass123!',
      synchronize: false,
      entities: [path.join(__dirname, '../../src/**/*.entity{.ts,.js}')],
    });

    await appDs.initialize();

    // Seed test tenant and users under tenant context
    const qr = appDs.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    await qr.query(`
      INSERT INTO tenants (id, name, slug, is_active)
      VALUES ('${tenantId}', 'RBAC Test Tenant', 'rbac-test-tenant', true)
      ON CONFLICT (id) DO NOTHING;
    `);

    await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

    await qr.query(`
      INSERT INTO users (id, tenant_id, email, password_hash, role, is_active)
      VALUES 
        ('${adminUserId}', '${tenantId}', 'admin@test.com', 'hash', 'ADMIN', true),
        ('${managerUserId}', '${tenantId}', 'manager@test.com', 'hash', 'MANAGER', true),
        ('${viewerUserId}', '${tenantId}', 'viewer@test.com', 'hash', 'VIEWER', true),
        ('${inactiveUserId}', '${tenantId}', 'inactive@test.com', 'hash', 'ADMIN', false)
      ON CONFLICT (tenant_id, id) DO NOTHING;
    `);
    await qr.commitTransaction();
    await qr.release();

    reflector = new Reflector();
    guard = new PermissionsGuard(reflector, appDs);
  });

  afterAll(async () => {
    if (appDs && appDs.isInitialized) {
      try {
        const cleanupQr = appDs.createQueryRunner();
        await cleanupQr.connect();
        await cleanupQr.startTransaction();
        await cleanupQr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
        await cleanupQr.query(`DELETE FROM users WHERE tenant_id = '${tenantId}';`);
        await cleanupQr.commitTransaction();
        await cleanupQr.release();
      } catch {
        // ignore cleanup error
      } finally {
        await appDs.destroy();
      }
    }
  });

  const createMockContext = (
    request: any,
    permissions?: Permission[],
    isPublic?: boolean,
  ): ExecutionContext => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: string) => {
      if (key === IS_PUBLIC_KEY) return isPublic ?? false;
      if (key === PERMISSIONS_KEY) return permissions;
      return undefined;
    });

    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  it('allows access to public endpoints without permission requirements', async () => {
    const context = createMockContext({}, undefined, true);
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('denies access by default with 403 INSUFFICIENT_PERMISSIONS when permission metadata is missing on non-public route', async () => {
    const context = createMockContext(
      { user: { sub: adminUserId, tenant_id: tenantId } },
      undefined,
      false,
    );
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('fails with 403 TENANT_MEMBERSHIP_REQUIRED when user is inactive in database', async () => {
    const context = createMockContext(
      { user: { sub: inactiveUserId, tenant_id: tenantId } },
      [Permission.ORDERS_READ],
      false,
    );

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    try {
      await guard.canActivate(context);
    } catch (err: any) {
      expect(err.response.error_code).toBe('TENANT_MEMBERSHIP_REQUIRED');
    }
  });

  it('ADMIN role is granted access to all permissions including users:manage, audit:read, sync:credentials', async () => {
    const context = createMockContext(
      { user: { sub: adminUserId, tenant_id: tenantId } },
      [Permission.USERS_MANAGE, Permission.AUDIT_READ, Permission.SYNC_CREDENTIALS],
      false,
    );

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('MANAGER role is allowed inventory and order operations but denied users:manage and audit:read', async () => {
    // Allowed
    const allowedContext = createMockContext(
      { user: { sub: managerUserId, tenant_id: tenantId } },
      [Permission.ORDERS_WRITE, Permission.INVENTORY_ADJUST],
      false,
    );
    expect(await guard.canActivate(allowedContext)).toBe(true);

    // Denied users:manage
    const deniedUserContext = createMockContext(
      { user: { sub: managerUserId, tenant_id: tenantId } },
      [Permission.USERS_MANAGE],
      false,
    );
    await expect(guard.canActivate(deniedUserContext)).rejects.toThrow(ForbiddenException);

    // Denied audit:read
    const deniedAuditContext = createMockContext(
      { user: { sub: managerUserId, tenant_id: tenantId } },
      [Permission.AUDIT_READ],
      false,
    );
    await expect(guard.canActivate(deniedAuditContext)).rejects.toThrow(ForbiddenException);
  });

  it('VIEWER role is granted read-only permissions and strictly denied write/mutation operations', async () => {
    // Allowed read
    const readContext = createMockContext(
      { user: { sub: viewerUserId, tenant_id: tenantId } },
      [Permission.ORDERS_READ, Permission.INVENTORY_READ, Permission.PRODUCTS_READ],
      false,
    );
    expect(await guard.canActivate(readContext)).toBe(true);

    // Denied write
    const writeContext = createMockContext(
      { user: { sub: viewerUserId, tenant_id: tenantId } },
      [Permission.ORDERS_WRITE],
      false,
    );
    await expect(guard.canActivate(writeContext)).rejects.toThrow(ForbiddenException);

    const adjustContext = createMockContext(
      { user: { sub: viewerUserId, tenant_id: tenantId } },
      [Permission.INVENTORY_ADJUST],
      false,
    );
    await expect(guard.canActivate(adjustContext)).rejects.toThrow(ForbiddenException);
  });

  it('immediate DB-backed role demotion: demoting user in DB rejects subsequent mutations immediately', async () => {
    const demotedUserId = '10000000-0000-0000-0000-000000000099';

    // Seed temporary admin user
    const qr = appDs.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
    await qr.query(`
      INSERT INTO users (id, tenant_id, email, password_hash, role, is_active)
      VALUES ('${demotedUserId}', '${tenantId}', 'demote@test.com', 'hash', 'ADMIN', true)
      ON CONFLICT (tenant_id, id) DO UPDATE SET role = 'ADMIN';
    `);
    await qr.commitTransaction();

    // Verify allowed as ADMIN
    const req1 = { user: { sub: demotedUserId, tenant_id: tenantId } };
    const ctx1 = createMockContext(req1, [Permission.USERS_MANAGE], false);
    expect(await guard.canActivate(ctx1)).toBe(true);

    // Demote role to VIEWER in database
    await qr.startTransaction();
    await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
    await qr.query(`UPDATE users SET role = 'VIEWER' WHERE id = '${demotedUserId}';`);
    await qr.commitTransaction();
    await qr.release();

    // Second request with SAME user token/sub now fails immediately due to DB-backed check
    const req2 = { user: { sub: demotedUserId, tenant_id: tenantId } };
    const ctx2 = createMockContext(req2, [Permission.USERS_MANAGE], false);
    await expect(guard.canActivate(ctx2)).rejects.toThrow(ForbiddenException);
  });
});
