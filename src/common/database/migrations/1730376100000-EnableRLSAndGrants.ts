import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration T039: Row-Level Security (RLS) & Non-Owner Role Grants Migration
 *
 * Implements:
 * 1. ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY on all 17 tenant-owned tables.
 * 2. Strict tenant isolation policies for `omnistock_app` evaluating:
 *    `tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid`
 * 3. Dedicated `omnistock_preauth_auditor` role and pre-auth INSERT policy on `audit_logs`.
 * 4. `public.record_pre_auth_audit_log(text, jsonb)` SECURITY DEFINER function.
 * 5. Explicit least-privilege DML grants for `omnistock_app` (revoking UPDATE, DELETE, TRUNCATE on append-only tables).
 *
 * Owned and executed by: `omnistock_migrator`
 */
export class EnableRLSAndGrants1730376100000 implements MigrationInterface {
  name = 'EnableRLSAndGrants1730376100000';

  private readonly tenantTables = [
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

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Enable & Force Row Level Security on all 17 tenant-owned tables
    for (const table of this.tenantTables) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY ${table}_tenant_isolation ON ${table}
          FOR ALL TO omnistock_app
          USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
          WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
      `);
    }

    // 2. Grant DML on mutable tenant tables to omnistock_app
    const mutableTables = [
      'users',
      'customers',
      'categories',
      'products',
      'warehouses',
      'inventory_items',
      'low_stock_alerts',
      'stock_transfers',
      'stock_transfer_items',
      'orders',
      'order_items',
      'order_allocations',
      'sync_webhook_credentials',
      'sync_logs',
    ];
    for (const table of mutableTables) {
      await queryRunner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO omnistock_app;`,
      );
    }

    // 3. Grant DML on global root tenants directory to omnistock_app
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON TABLE tenants TO omnistock_app;`);

    // 4. Grant SELECT, INSERT ONLY on append-only tables (explicitly revoke UPDATE, DELETE, TRUNCATE)
    const appendOnlyTables = ['stock_movements', 'audit_logs', 'sync_attempts'];
    for (const table of appendOnlyTables) {
      await queryRunner.query(`GRANT SELECT, INSERT ON TABLE ${table} TO omnistock_app;`);
      await queryRunner.query(
        `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${table} FROM omnistock_app;`,
      );
    }

    // 5. Setup omnistock_preauth_auditor for unauthenticated security logs (tenant_id IS NULL)
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'omnistock_preauth_auditor') THEN
          CREATE ROLE omnistock_preauth_auditor WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`GRANT USAGE, CREATE ON SCHEMA public TO omnistock_preauth_auditor;`);
    await queryRunner.query(`GRANT INSERT ON TABLE audit_logs TO omnistock_preauth_auditor;`);

    await queryRunner.query(`
      CREATE POLICY audit_logs_preauth_insert ON audit_logs
        FOR INSERT TO omnistock_preauth_auditor
        WITH CHECK (
          tenant_id IS NULL
          AND actor_user_id IS NULL
          AND entity_type = 'Auth'
          AND action IN ('AUTH_LOGIN_FAILURE', 'AUTH_TOKEN_INVALID', 'SYNC_WEBHOOK_AUTH_FAILURE')
        );
    `);

    // 6. Create SECURITY DEFINER function owned by omnistock_preauth_auditor
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_pre_auth_audit_log(p_action text, p_metadata jsonb)
      RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        v_log_id uuid;
      BEGIN
        IF p_action NOT IN ('AUTH_LOGIN_FAILURE', 'AUTH_TOKEN_INVALID', 'SYNC_WEBHOOK_AUTH_FAILURE') THEN
          RAISE EXCEPTION 'Invalid pre-auth audit action: %', p_action USING ERRCODE = 'check_violation';
        END IF;

        v_log_id := gen_random_uuid();
        INSERT INTO audit_logs (id, tenant_id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
        VALUES (v_log_id, NULL, NULL, p_action, 'Auth', NULL, p_metadata, CURRENT_TIMESTAMP);

        RETURN v_log_id;
      END;
      $$;

      ALTER FUNCTION public.record_pre_auth_audit_log(text, jsonb) OWNER TO omnistock_preauth_auditor;
      SET ROLE omnistock_preauth_auditor;
      REVOKE ALL ON FUNCTION public.record_pre_auth_audit_log(text, jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.record_pre_auth_audit_log(text, jsonb) TO omnistock_app;
      RESET ROLE;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS public.record_pre_auth_audit_log(text, jsonb) CASCADE;`,
    );
    await queryRunner.query(`DROP POLICY IF EXISTS audit_logs_preauth_insert ON audit_logs;`);

    for (const table of this.tenantTables) {
      await queryRunner.query(`DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};`);
      await queryRunner.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`REVOKE ALL ON TABLE ${table} FROM omnistock_app;`);
    }

    await queryRunner.query(`REVOKE ALL ON TABLE tenants FROM omnistock_app;`);
  }
}
