import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

describe('Connection-Pool Tenant Context Isolation Tests (T045)', () => {
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
      extra: {
        max: 5, // small pool to force connection reuse
      },
      entities: [path.join(__dirname, '../../src/**/*.entity{.ts,.js}')],
    });

    await appDs.initialize();

    // Insert test data for tenant A and tenant B
    const qr = appDs.createQueryRunner();
    await qr.connect();

    // Seed tenant A customer
    await qr.startTransaction();
    await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);
    await qr.query(`
      INSERT INTO customers (id, tenant_id, name)
      VALUES ('ca000000-0000-0000-0000-000000000001', '${tenantAId}', 'Tenant A Customer')
      ON CONFLICT (tenant_id, id) DO NOTHING;
    `);
    await qr.commitTransaction();

    // Seed tenant B customer
    await qr.startTransaction();
    await qr.query(`SET LOCAL app.current_tenant_id = '${tenantBId}';`);
    await qr.query(`
      INSERT INTO customers (id, tenant_id, name)
      VALUES ('cb000000-0000-0000-0000-000000000001', '${tenantBId}', 'Tenant B Customer')
      ON CONFLICT (tenant_id, id) DO NOTHING;
    `);
    await qr.commitTransaction();

    await qr.release();
  });

  afterAll(async () => {
    if (appDs && appDs.isInitialized) {
      await appDs.destroy();
    }
  });

  it('SET LOCAL automatically resets after transaction commit and leaves zero leakage on the connection', async () => {
    const qr = appDs.createQueryRunner();
    await qr.connect();

    try {
      // Transaction 1: Set Tenant A
      await qr.startTransaction();
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);
      const rowsInTx = await qr.query(`SELECT * FROM customers;`);
      expect(rowsInTx).toHaveLength(1);
      expect(rowsInTx[0].tenant_id).toBe(tenantAId);
      await qr.commitTransaction();

      // Outside transaction on same connection: setting must have reset
      const val = await qr.query(`SELECT current_setting('app.current_tenant_id', true) as val;`);
      expect(val[0].val).toBe('');

      // And query outside transaction sees 0 rows
      const rowsOutside = await qr.query(`SELECT * FROM customers;`);
      expect(rowsOutside).toHaveLength(0);
    } finally {
      await qr.release();
    }
  });

  it('sequential transactions on same pooled connection switch tenant contexts cleanly', async () => {
    const qr = appDs.createQueryRunner();
    await qr.connect();

    try {
      // Tx 1: Tenant A
      await qr.startTransaction();
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);
      const rowsA = await qr.query(`SELECT * FROM customers;`);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0].tenant_id).toBe(tenantAId);
      await qr.commitTransaction();

      // Tx 2: Tenant B
      await qr.startTransaction();
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantBId}';`);
      const rowsB = await qr.query(`SELECT * FROM customers;`);
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].tenant_id).toBe(tenantBId);
      await qr.commitTransaction();

      // Post-check: reset
      const postRows = await qr.query(`SELECT * FROM customers;`);
      expect(postRows).toHaveLength(0);
    } finally {
      await qr.release();
    }
  });

  it('concurrent transactions running in parallel against different tenants have zero cross-tenant leakage', async () => {
    const runTenantTx = async (tenantId: string) => {
      const qr = appDs.createQueryRunner();
      await qr.connect();
      try {
        await qr.startTransaction();
        await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

        // Artificial small delay to test interleaving
        await new Promise((r) => setTimeout(r, 20));

        const rows = await qr.query(`SELECT id, tenant_id FROM customers;`);
        await qr.commitTransaction();
        return rows;
      } finally {
        await qr.release();
      }
    };

    // Run multiple concurrent queries across tenant A and B simultaneously
    const results = await Promise.all([
      runTenantTx(tenantAId),
      runTenantTx(tenantBId),
      runTenantTx(tenantAId),
      runTenantTx(tenantBId),
    ]);

    // Check results for Tenant A
    expect(results[0]).toHaveLength(1);
    expect(results[0][0].tenant_id).toBe(tenantAId);
    expect(results[2]).toHaveLength(1);
    expect(results[2][0].tenant_id).toBe(tenantAId);

    // Check results for Tenant B
    expect(results[1]).toHaveLength(1);
    expect(results[1][0].tenant_id).toBe(tenantBId);
    expect(results[3]).toHaveLength(1);
    expect(results[3][0].tenant_id).toBe(tenantBId);
  });
});
