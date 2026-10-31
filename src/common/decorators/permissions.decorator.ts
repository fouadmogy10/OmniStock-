import { SetMetadata } from '@nestjs/common';

/**
 * All 29 explicit RBAC permissions defined in spec.md (FR-002).
 */
export enum Permission {
  TENANT_READ = 'tenant:read',
  USERS_READ = 'users:read',
  USERS_MANAGE = 'users:manage',
  AUDIT_READ = 'audit:read',
  CUSTOMERS_READ = 'customers:read',
  CUSTOMERS_WRITE = 'customers:write',
  CATEGORIES_READ = 'categories:read',
  CATEGORIES_WRITE = 'categories:write',
  PRODUCTS_READ = 'products:read',
  PRODUCTS_WRITE = 'products:write',
  WAREHOUSES_READ = 'warehouses:read',
  WAREHOUSES_WRITE = 'warehouses:write',
  INVENTORY_READ = 'inventory:read',
  INVENTORY_ADJUST = 'inventory:adjust',
  INVENTORY_THRESHOLD = 'inventory:threshold',
  MOVEMENTS_READ = 'movements:read',
  TRANSFERS_READ = 'transfers:read',
  TRANSFERS_WRITE = 'transfers:write',
  TRANSFERS_EXECUTE = 'transfers:execute',
  ORDERS_READ = 'orders:read',
  ORDERS_WRITE = 'orders:write',
  ORDERS_ALLOCATE = 'orders:allocate',
  ORDERS_SHIP = 'orders:ship',
  ORDERS_CANCEL = 'orders:cancel',
  ALERTS_READ = 'alerts:read',
  DASHBOARD_READ = 'dashboard:read',
  SYNC_READ = 'sync:read',
  SYNC_RETRY = 'sync:retry',
  SYNC_CREDENTIALS = 'sync:credentials',
}

export const PERMISSIONS_KEY = 'permissions';
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
