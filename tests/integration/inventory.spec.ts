import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';

describe('Inventory & StockMovement Immutability Integration Tests (T023)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let tenantId: string;
  let productId: string;
  let parentProductId: string;
  let warehouseId: string;

  const timestamp = Date.now();
  const tenantSlug = `inv-test-${timestamp}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter());

    await app.init();
    dataSource = app.get(DataSource);

    // 1. Onboard tenant
    const onboardRes = await request(app.getHttpServer())
      .post('/tenants')
      .send({
        name: 'Inventory Test Tenant',
        slug: tenantSlug,
        admin_email: `admin-${timestamp}@invtest.com`,
        admin_password: 'AdminPassword123!',
      })
      .expect(201);

    tenantId = onboardRes.body.tenant.id;

    // 2. Login
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: tenantSlug,
        email: `admin-${timestamp}@invtest.com`,
        password: 'AdminPassword123!',
      })
      .expect(200);

    adminToken = loginRes.body.access_token;

    // 3. Create Warehouse
    const whRes = await request(app.getHttpServer())
      .post('/warehouses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Warehouse-${timestamp}`,
        location: 'Riyadh',
        priority: 1,
      })
      .expect(201);

    warehouseId = whRes.body.id;

    // 4. Create Standalone Product
    const prodRes = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: `SKU-INV-${timestamp}`,
        name: 'Inventory Test Product',
        price: 99.99,
        is_variant_parent: false,
      })
      .expect(201);

    productId = prodRes.body.id;

    // 5. Create Variant Parent Product
    const parentRes = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: `PARENT-INV-${timestamp}`,
        name: 'Parent Container Product',
        price: 0,
        is_variant_parent: true,
      })
      .expect(201);

    parentProductId = parentRes.body.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('rejects stock adjustment with delta = 0', async () => {
    const res = await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: 0,
      })
      .expect(400);

    expect(res.body.error_code).toBe('VALIDATION_ERROR');
  });

  it('rejects stock adjustment on a variant parent container product', async () => {
    const res = await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: parentProductId,
        warehouse_id: warehouseId,
        delta: 10,
      })
      .expect(400);

    expect(res.body.error_code).toBe('VARIANT_PARENT_NOT_SELLABLE');
  });

  it('successfully adjusts stock and creates immutable StockMovement record', async () => {
    // Initial adjustment: +20
    const adjustRes = await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: 20,
        reason: 'Initial stock intake',
      })
      .expect(200);

    expect(adjustRes.body.on_hand).toBe(20);
    expect(adjustRes.body.available).toBe(20);
    expect(adjustRes.body.reserved).toBe(0);

    // Negative adjustment: -5 -> on_hand: 15
    const adjustRes2 = await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: -5,
        reason: 'Damage deduction',
      })
      .expect(200);

    expect(adjustRes2.body.on_hand).toBe(15);
    expect(adjustRes2.body.available).toBe(15);

    // Insufficient stock adjustment: -20 -> rejected 409
    const errRes = await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: -20,
      })
      .expect(409);

    expect(errRes.body.error_code).toBe('INSUFFICIENT_STOCK');
  });

  it('verifies StockMovement database immutability: trigger rejects UPDATE and DELETE', async () => {
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const movements = await qr.query(
        `SELECT id FROM stock_movements WHERE tenant_id = $1 AND product_id = $2;`,
        [tenantId, productId],
      );

      expect(movements.length).toBeGreaterThanOrEqual(2);
      const movementId = movements[0].id;

      // UPDATE must fail at the trigger level
      await expect(
        qr.query(`UPDATE stock_movements SET delta = 999 WHERE id = $1 AND tenant_id = $2;`, [
          movementId,
          tenantId,
        ]),
      ).rejects.toThrow();

      // DELETE must fail at the trigger level
      await expect(
        qr.query(`DELETE FROM stock_movements WHERE id = $1 AND tenant_id = $2;`, [
          movementId,
          tenantId,
        ]),
      ).rejects.toThrow();

      await qr.rollbackTransaction();
    } finally {
      await qr.release();
    }
  });

  it('verifies InventoryItem database CHECK constraints fail closed', async () => {
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const [item] = await qr.query(
        `SELECT id FROM inventory_items WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3;`,
        [tenantId, productId, warehouseId],
      );

      expect(item).toBeDefined();

      // chk_inventory_on_hand_non_negative: on_hand < 0 rejected
      await expect(
        qr.query(`UPDATE inventory_items SET on_hand = -1 WHERE id = $1;`, [item.id]),
      ).rejects.toThrow();

      // chk_inventory_reserved_non_negative: reserved < 0 rejected
      await expect(
        qr.query(`UPDATE inventory_items SET reserved = -1 WHERE id = $1;`, [item.id]),
      ).rejects.toThrow();

      // chk_inventory_reserved_lte_on_hand: reserved > on_hand rejected
      await expect(
        qr.query(`UPDATE inventory_items SET reserved = 999, on_hand = 10 WHERE id = $1;`, [
          item.id,
        ]),
      ).rejects.toThrow();

      // chk_inventory_in_transit_non_negative: in_transit < 0 rejected
      await expect(
        qr.query(`UPDATE inventory_items SET in_transit = -5 WHERE id = $1;`, [item.id]),
      ).rejects.toThrow();

      // chk_inventory_low_stock_threshold: low_stock_threshold < 0 rejected
      await expect(
        qr.query(`UPDATE inventory_items SET low_stock_threshold = -2 WHERE id = $1;`, [item.id]),
      ).rejects.toThrow();

      await qr.rollbackTransaction();
    } finally {
      await qr.release();
    }
  });
});
