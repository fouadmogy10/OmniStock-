import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

describe('Migrations & Role Security Integration Tests (T041)', () => {
  let migratorDs: DataSource;
  let appDs: DataSource;

  beforeAll(async () => {
    migratorDs = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'omnistock',
      username: process.env.DB_MIGRATOR_USER || 'omnistock_migrator',
      password: process.env.DB_MIGRATOR_PASSWORD || 'MigratorSecurePass123!',
      synchronize: false,
      migrationsRun: false,
      entities: [path.join(__dirname, '../../src/**/*.entity{.ts,.js}')],
      migrations: [path.join(__dirname, '../../src/common/database/migrations/*{.ts,.js}')],
      migrationsTableName: 'typeorm_migrations',
    });

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

    await migratorDs.initialize();
    await appDs.initialize();
  });

  afterAll(async () => {
    if (appDs && appDs.isInitialized) {
      await appDs.destroy();
    }
    if (migratorDs && migratorDs.isInitialized) {
      await migratorDs.destroy();
    }
  });

  it('omnistock_app must have rolsuper = false and rolbypassrls = false', async () => {
    const roles = await appDs.query(`
      SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
      FROM pg_roles
      WHERE rolname = current_user;
    `);

    expect(roles).toHaveLength(1);
    expect(roles[0].rolsuper).toBe(false);
    expect(roles[0].rolbypassrls).toBe(false);
    expect(roles[0].rolcreatedb).toBe(false);
    expect(roles[0].rolcreaterole).toBe(false);
  });

  it('omnistock_app must not own public schema or any of the 17 tenant tables', async () => {
    const schemaOwner = await appDs.query(`
      SELECT schema_owner FROM information_schema.schemata WHERE schema_name = 'public';
    `);
    expect(schemaOwner[0].schema_owner).toBe('omnistock_migrator');

    const tenantTables = [
      'users',
      'audit_logs',
      'customers',
      'categories',
      'products',
      'warehouses',
      'inventory_items',
      'low_stock_alerts',
      'stock_movements',
      'stock_transfers',
      'stock_transfer_items',
      'orders',
      'order_items',
      'order_allocations',
      'sync_webhook_credentials',
      'sync_logs',
      'sync_attempts',
    ];

    const tableOwners = await appDs.query(
      `
      SELECT tablename, tableowner
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY($1);
    `,
      [tenantTables],
    );

    expect(tableOwners).toHaveLength(17);
    for (const row of tableOwners) {
      expect(row.tableowner).toBe('omnistock_migrator');
      expect(row.tableowner).not.toBe('omnistock_app');
    }
  });

  it('omnistock_app must not be able to execute DDL (DISABLE RLS, DROP POLICY)', async () => {
    await expect(
      appDs.query('ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;'),
    ).rejects.toThrow();

    await expect(
      appDs.query('DROP POLICY audit_logs_tenant_isolation ON audit_logs;'),
    ).rejects.toThrow();
  });

  it('omnistock_app must be prohibited from UPDATE, DELETE on append-only tables', async () => {
    const appendOnlyTables = ['stock_movements', 'audit_logs', 'sync_attempts'];

    for (const table of appendOnlyTables) {
      await expect(appDs.query(`UPDATE ${table} SET id = gen_random_uuid();`)).rejects.toThrow();

      await expect(appDs.query(`DELETE FROM ${table};`)).rejects.toThrow();
    }
  });

  it('all 17 tenant tables must have rowsecurity = true and force_rowsecurity = true', async () => {
    const tenantTables = [
      'users',
      'audit_logs',
      'customers',
      'categories',
      'products',
      'warehouses',
      'inventory_items',
      'low_stock_alerts',
      'stock_movements',
      'stock_transfers',
      'stock_transfer_items',
      'orders',
      'order_items',
      'order_allocations',
      'sync_webhook_credentials',
      'sync_logs',
      'sync_attempts',
    ];

    const rlsStatus = await migratorDs.query(
      `
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1);
    `,
      [tenantTables],
    );

    expect(rlsStatus).toHaveLength(17);
    for (const table of rlsStatus) {
      expect(table.relrowsecurity).toBe(true);
      expect(table.relforcerowsecurity).toBe(true);
    }
  });
});
