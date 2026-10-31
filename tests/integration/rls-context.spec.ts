import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

describe('Fail-Closed RLS Behavior Integration Tests (T044)', () => {
  let appDs: DataSource;

  const tenantAId = 'a0000000-0000-0000-0000-000000000001';
  const tenantBId = 'b0000000-0000-0000-0000-000000000002';

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
  });

  afterAll(async () => {
    if (appDs && appDs.isInitialized) {
      await appDs.destroy();
    }
  });

  it('when app.current_tenant_id is UNSET, 0 rows read and writes are rejected', async () => {
    const qr = appDs.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // Ensure app.current_tenant_id is not set
      await qr.query(`RESET app.current_tenant_id;`);

      const rows = await qr.query(`SELECT * FROM customers;`);
      expect(rows).toHaveLength(0);

      await expect(
        qr.query(`
          INSERT INTO customers (id, tenant_id, name)
          VALUES (gen_random_uuid(), '${tenantAId}', 'Unset Test Customer');
        `),
      ).rejects.toThrow();
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('when app.current_tenant_id is EMPTY (""), 0 rows read and writes are rejected', async () => {
    const qr = appDs.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '';`);

      const rows = await qr.query(`SELECT * FROM customers;`);
      expect(rows).toHaveLength(0);

      await expect(
        qr.query(`
          INSERT INTO customers (id, tenant_id, name)
          VALUES (gen_random_uuid(), '${tenantAId}', 'Empty Test Customer');
        `),
      ).rejects.toThrow();
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('when app.current_tenant_id is VALID UUID, strictly matches active tenant data', async () => {
    const qr = appDs.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);

      const customerId = 'c1111111-1111-1111-1111-111111111111';
      await qr.query(`
        INSERT INTO customers (id, tenant_id, name)
        VALUES ('${customerId}', '${tenantAId}', 'Valid Tenant Customer');
      `);

      const rows = await qr.query(`SELECT id, tenant_id, name FROM customers WHERE id = $1;`, [
        customerId,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(tenantAId);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('when app.current_tenant_id is MALFORMED, fails closed with PostgreSQL UUID cast error 22P02', async () => {
    const qr = appDs.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = 'malformed-not-a-uuid';`);

      await expect(qr.query(`SELECT * FROM customers;`)).rejects.toThrow(
        /invalid input syntax for type uuid/,
      );
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });
});
