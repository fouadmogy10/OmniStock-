import { Permission, ROLE_PERMISSIONS_MATRIX } from '@common/guards/permissions.guard';

describe('Permissions Matrix Unit Tests (FR-002)', () => {
  it('should define exactly 29 permissions in Permission enum', () => {
    const permissions = Object.values(Permission);
    expect(permissions).toHaveLength(29);
  });

  it('ADMIN role should grant all 29 permissions', () => {
    const adminPermissions = ROLE_PERMISSIONS_MATRIX['ADMIN'];
    expect(adminPermissions).toHaveLength(29);
    expect(adminPermissions).toContain(Permission.SYNC_CREDENTIALS);
    expect(adminPermissions).toContain(Permission.USERS_MANAGE);
    expect(adminPermissions).toContain(Permission.AUDIT_READ);
  });

  it('MANAGER role should grant exactly 25 permissions (excluding users, audit, credentials)', () => {
    const managerPermissions = ROLE_PERMISSIONS_MATRIX['MANAGER'];
    expect(managerPermissions).toHaveLength(25);
    expect(managerPermissions).not.toContain(Permission.USERS_READ);
    expect(managerPermissions).not.toContain(Permission.USERS_MANAGE);
    expect(managerPermissions).not.toContain(Permission.AUDIT_READ);
    expect(managerPermissions).not.toContain(Permission.SYNC_CREDENTIALS);
  });

  it('VIEWER role should grant read-only permissions and exclude all write mutations', () => {
    const viewerPermissions = ROLE_PERMISSIONS_MATRIX['VIEWER'];
    expect(viewerPermissions).toHaveLength(11);
    expect(viewerPermissions).not.toContain(Permission.ORDERS_WRITE);
    expect(viewerPermissions).not.toContain(Permission.INVENTORY_ADJUST);
    expect(viewerPermissions).not.toContain(Permission.TRANSFERS_WRITE);
    expect(viewerPermissions).not.toContain(Permission.TRANSFERS_EXECUTE);
  });
});
