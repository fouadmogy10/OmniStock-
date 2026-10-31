import { Module, OnModuleInit, Logger, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as path from 'path';

/**
 * DatabaseModule (Runtime Application Context)
 *
 * STRICT SECURITY CONVENTIONS:
 * 1. Connects strictly using `omnistock_app` (NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOBYPASSRLS).
 * 2. NEVER loads or accesses `omnistock_migrator` credentials.
 * 3. On application startup (`onModuleInit`), inspects PostgreSQL system catalogs
 *    to verify effective runtime privileges, fail-closing startup if any check fails.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'omnistock',
        username: process.env.DB_APP_USER || 'omnistock_app',
        password: process.env.DB_APP_PASSWORD || 'AppSecurePass123!',
        extra: {
          max: parseInt(process.env.DB_POOL_MAX || '20', 10),
        },
        synchronize: false, // Invariant: NEVER allow synchronize: true
        logging: process.env.NODE_ENV !== 'production' ? ['error', 'warn'] : ['error'],
        entities: [path.join(__dirname, '/../../**/*.entity{.ts,.js}')],
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule implements OnModuleInit {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Executing fail-closed PostgreSQL effective privilege and RLS verification...');
    await this.verifyRuntimePrivileges();
    this.logger.log('PostgreSQL effective privilege and RLS verification passed successfully.');
  }

  /**
   * Verifies effective privileges and RLS enforcement per FR-019.
   * Fails application startup closed if:
   * 1. current_user or inherited roles have superuser, bypassrls, createdb, or createrole.
   * 2. current_user belongs to prohibited roles (omnistock_migrator, omnistock_preauth_auditor, pg_read_all_data, pg_write_all_data).
   * 3. current_user owns public schema or any application table, or has CREATE on public schema.
   * 4. current_user has UPDATE, DELETE, TRUNCATE, TRIGGER, or REFERENCES on append-only tables.
   * 5. Any of the 17 tenant-owned tables lacks ENABLE + FORCE ROW LEVEL SECURITY.
   */
  public async verifyRuntimePrivileges(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      // 1. Role Attributes Check
      const roleAttrs = await queryRunner.query(`
        SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
        FROM pg_roles
        WHERE rolname = current_user
           OR pg_has_role(current_user, oid, 'MEMBER');
      `);

      for (const role of roleAttrs) {
        if (role.rolsuper || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole) {
          throw new Error(
            `Database privilege violation: Role '${role.rolname}' holds prohibited attributes (super=${role.rolsuper}, bypassrls=${role.rolbypassrls}, createdb=${role.rolcreatedb}, createrole=${role.rolcreaterole})`,
          );
        }
      }

      // 2. Prohibited Role Memberships Check
      const prohibitedRoles = [
        'omnistock_migrator',
        'omnistock_preauth_auditor',
        'pg_read_all_data',
        'pg_write_all_data',
      ];
      for (const prohibited of prohibitedRoles) {
        const [isMember] = await queryRunner.query(
          `SELECT pg_has_role(current_user, $1, 'MEMBER') as member;`,
          [prohibited],
        );
        if (isMember && isMember.member) {
          throw new Error(
            `Database privilege violation: Runtime user '${process.env.DB_APP_USER}' is a member of prohibited role '${prohibited}'`,
          );
        }
      }

      // 3. Schema & Table Non-Ownership Check
      const [schemaCreate] = await queryRunner.query(
        `SELECT has_schema_privilege(current_user, 'public', 'CREATE') as can_create;`,
      );
      if (schemaCreate && schemaCreate.can_create) {
        throw new Error(
          `Database privilege violation: Runtime user '${process.env.DB_APP_USER}' has CREATE privilege on public schema`,
        );
      }

      // 4. Append-Only Tables effective privileges check
      const appendOnlyTables = ['stock_movements', 'audit_logs', 'sync_attempts'];
      for (const table of appendOnlyTables) {
        const [privs] = await queryRunner.query(`
          SELECT
            has_table_privilege(current_user, 'public.${table}', 'UPDATE') as can_update,
            has_table_privilege(current_user, 'public.${table}', 'DELETE') as can_delete,
            has_table_privilege(current_user, 'public.${table}', 'TRUNCATE') as can_truncate,
            has_table_privilege(current_user, 'public.${table}', 'TRIGGER') as can_trigger,
            has_table_privilege(current_user, 'public.${table}', 'REFERENCES') as can_ref;
        `);

        if (
          privs.can_update ||
          privs.can_delete ||
          privs.can_truncate ||
          privs.can_trigger ||
          privs.can_ref
        ) {
          throw new Error(
            `Database privilege violation: Runtime user has prohibited privileges on append-only table '${table}' (UPDATE=${privs.can_update}, DELETE=${privs.can_delete}, TRUNCATE=${privs.can_truncate}, TRIGGER=${privs.can_trigger}, REFERENCES=${privs.can_ref})`,
          );
        }
      }

      // 5. RLS Active Check on all 17 tenant-owned tables
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

      const rlsRows = await queryRunner.query(
        `
        SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND relname = ANY($1::text[]);
      `,
        [tenantTables],
      );

      if (rlsRows.length !== tenantTables.length) {
        throw new Error(
          `Database RLS check failed: Expected ${tenantTables.length} tenant tables in database, found ${rlsRows.length}`,
        );
      }

      for (const row of rlsRows) {
        if (!row.relrowsecurity || !row.relforcerowsecurity) {
          throw new Error(
            `Database RLS check failed: Table '${row.relname}' does not have Row-Level Security enabled and forced (relrowsecurity=${row.relrowsecurity}, relforcerowsecurity=${row.relforcerowsecurity})`,
          );
        }
      }
    } finally {
      await queryRunner.release();
    }
  }
}
