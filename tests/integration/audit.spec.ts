import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

describe('AuditLog Integration Tests (T043)', () => {
  let migratorDs: DataSource;
  let appDs: DataSource;

  const tenantAId = 'a0000000-0000-0000-0000-000000000001';
  const tenantBId = 'b0000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    migratorDs = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'omnistock',
      username: process.env.DB_MIGRATOR_USER || 'omnistock_migrator',
      password: process.env.DB_MIGRATOR_PASSWORD || 'MigratorSecurePass123!',
      synchronize: false,
      entities: [path.join(__dirname, '../../src/**/*.entity{.ts,.js}')],
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

    // Ensure tenants exist for testing
    await migratorDs.query(`
      INSERT INTO tenants (id, name, slug)
      VALUES 
        ('${tenantAId}', 'Tenant A', 'tenant-a'),
        ('${tenantBId}', 'Tenant B', 'tenant-b')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(async () => {
    if (appDs && appDs.isInitialized) {
      await appDs.destroy();
    }
    if (migratorDs && migratorDs.isInitialized) {
      await migratorDs.destroy();
    }
  });

  it('pre-auth audit log can be recorded via public.record_pre_auth_audit_log', async () => {
    const res = await appDs.query(`SELECT public.record_pre_auth_audit_log($1, $2) as id;`, [
      'AUTH_LOGIN_FAILURE',
      JSON.stringify({ ip: '127.0.0.1', reason: 'Bad password' }),
    ]);

    expect(res).toHaveLength(1);
    expect(res[0].id).toBeDefined();

    // Verify row directly via superuser (since RLS hides tenant_id IS NULL from tenant/migrator queries)
    const adminDs = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'omnistock',
      username: 'postgres',
      password:
        process.env.POSTGRES_PASSWORD ||
        process.env.PGPASSWORD ||
        (process.env.CI ? 'postgres' : 'PostgresSuperSecretPass123!'),
      synchronize: false,
    });
    await adminDs.initialize();
    try {
      const [row] = await adminDs.query(`SELECT * FROM audit_logs WHERE id = $1;`, [res[0].id]);
      expect(row).toBeDefined();
      expect(row.tenant_id).toBeNull();
      expect(row.actor_user_id).toBeNull();
      expect(row.action).toBe('AUTH_LOGIN_FAILURE');
      expect(row.entity_type).toBe('Auth');
    } finally {
      await adminDs.destroy();
    }
  });

  it('direct INSERT with tenant_id IS NULL by omnistock_app is rejected by RLS', async () => {
    const qr = appDs.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);

      await expect(
        qr.query(`
          INSERT INTO audit_logs (id, tenant_id, action, entity_type)
          VALUES (gen_random_uuid(), NULL, 'DIRECT_ATTEMPT', 'Security');
        `),
      ).rejects.toThrow();
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('tenant queries cannot view pre-auth logs or logs from other tenants', async () => {
    // Record one log for Tenant A and one pre-auth log
    const [preAuth] = await appDs.query(`SELECT public.record_pre_auth_audit_log($1, $2) as id;`, [
      'AUTH_TOKEN_INVALID',
      JSON.stringify({ ip: '10.0.0.1' }),
    ]);

    const qr = appDs.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);

      // Insert tenant A log
      const logAId = 'a1111111-1111-1111-1111-111111111111';
      await qr.query(`
        INSERT INTO audit_logs (id, tenant_id, action, entity_type)
        VALUES ('${logAId}', '${tenantAId}', 'TENANT_A_ACTION', 'General');
      `);

      // Query audit logs as tenant A
      const logs = await qr.query(`SELECT id, tenant_id, action FROM audit_logs;`);

      const ids = logs.map((l: any) => l.id);
      expect(ids).toContain(logAId);
      expect(ids).not.toContain(preAuth.id);

      // Verify no NULL tenant_id is returned
      for (const log of logs) {
        expect(log.tenant_id).toBe(tenantAId);
      }
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('UPDATE and DELETE on audit_logs must be rejected by PostgreSQL immutability trigger', async () => {
    const qr = appDs.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);

      const [log] = await qr.query(`
        INSERT INTO audit_logs (id, tenant_id, action, entity_type)
        VALUES (gen_random_uuid(), '${tenantAId}', 'IMMUTABILITY_TEST', 'Test')
        RETURNING id;
      `);

      await expect(
        qr.query(`UPDATE audit_logs SET action = 'MUTATED' WHERE id = $1;`, [log.id]),
      ).rejects.toThrow();

      await expect(qr.query(`DELETE FROM audit_logs WHERE id = $1;`, [log.id])).rejects.toThrow();
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });
});
