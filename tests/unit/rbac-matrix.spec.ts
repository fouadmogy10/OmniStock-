import { Permission, ROLE_PERMISSIONS_MATRIX } from '../../src/common/guards/permissions.guard';

describe('RBAC Permission Matrix Unit Tests (T074, FR-002)', () => {
  const allPermissions = Object.values(Permission);

  it('defines exactly 29 unique permissions', () => {
    expect(allPermissions).toHaveLength(29);
    const unique = new Set(allPermissions);
    expect(unique.size).toBe(29);
  });

  describe('ADMIN Role', () => {
    it('holds all 29 permissions', () => {
      const adminPerms = ROLE_PERMISSIONS_MATRIX.ADMIN;
      expect(adminPerms).toHaveLength(29);
      for (const perm of allPermissions) {
        expect(adminPerms).toContain(perm);
      }
    });
  });

  describe('MANAGER Role', () => {
    const managerPerms = ROLE_PERMISSIONS_MATRIX.MANAGER;

    it('holds operational permissions (inventory, orders, catalog, dashboard, transfers)', () => {
      expect(managerPerms).toContain(Permission.ORDERS_ALLOCATE);
      expect(managerPerms).toContain(Permission.ORDERS_SHIP);
      expect(managerPerms).toContain(Permission.ORDERS_CANCEL);
      expect(managerPerms).toContain(Permission.INVENTORY_ADJUST);
      expect(managerPerms).toContain(Permission.TRANSFERS_EXECUTE);
      expect(managerPerms).toContain(Permission.DASHBOARD_READ);
      expect(managerPerms).toContain(Permission.SYNC_READ);
      expect(managerPerms).toContain(Permission.SYNC_RETRY);
    });

    it('prohibits security, credential, and user-management permissions', () => {
      expect(managerPerms).not.toContain(Permission.USERS_READ);
      expect(managerPerms).not.toContain(Permission.USERS_MANAGE);
      expect(managerPerms).not.toContain(Permission.AUDIT_READ);
      expect(managerPerms).not.toContain(Permission.SYNC_CREDENTIALS);
    });
  });

  describe('VIEWER Role', () => {
    const viewerPerms = ROLE_PERMISSIONS_MATRIX.VIEWER;

    it('holds read-only permissions for business domain and dashboard', () => {
      expect(viewerPerms).toContain(Permission.TENANT_READ);
      expect(viewerPerms).toContain(Permission.PRODUCTS_READ);
      expect(viewerPerms).toContain(Permission.INVENTORY_READ);
      expect(viewerPerms).toContain(Permission.MOVEMENTS_READ);
      expect(viewerPerms).toContain(Permission.ORDERS_READ);
      expect(viewerPerms).toContain(Permission.DASHBOARD_READ);
      expect(viewerPerms).toContain(Permission.ALERTS_READ);
    });

    it('prohibits all mutation / write / execution actions', () => {
      expect(viewerPerms).not.toContain(Permission.ORDERS_WRITE);
      expect(viewerPerms).not.toContain(Permission.ORDERS_ALLOCATE);
      expect(viewerPerms).not.toContain(Permission.ORDERS_SHIP);
      expect(viewerPerms).not.toContain(Permission.ORDERS_CANCEL);
      expect(viewerPerms).not.toContain(Permission.INVENTORY_ADJUST);
      expect(viewerPerms).not.toContain(Permission.TRANSFERS_WRITE);
      expect(viewerPerms).not.toContain(Permission.TRANSFERS_EXECUTE);
      expect(viewerPerms).not.toContain(Permission.SYNC_RETRY);
      expect(viewerPerms).not.toContain(Permission.USERS_MANAGE);
      expect(viewerPerms).not.toContain(Permission.SYNC_CREDENTIALS);
    });
  });
});
