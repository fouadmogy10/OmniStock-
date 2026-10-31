import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';

describe('LowStockAlert Lifecycle & Movements Integration Tests (T061)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let tenantId: string;
  let warehouseId: string;
  let productId: string;
  let inventoryItemId: string;

  const timestamp = Date.now();
  const tenantSlug = `lsa-test-${timestamp}`;

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
        name: 'Low Stock Alert Tenant',
        slug: tenantSlug,
        admin_email: `admin-${timestamp}@lsatest.com`,
        admin_password: 'AdminPassword123!',
      })
      .expect(201);

    tenantId = onboardRes.body.tenant.id;

    // 2. Login
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: tenantSlug,
        email: `admin-${timestamp}@lsatest.com`,
        password: 'AdminPassword123!',
      })
      .expect(200);

    adminToken = loginRes.body.access_token;

    // 3. Create Warehouse
    const whRes = await request(app.getHttpServer())
      .post('/warehouses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `LSA-Warehouse-${timestamp}`,
        location: 'Dammam',
        priority: 1,
      })
      .expect(201);

    warehouseId = whRes.body.id;

    // 4. Create Product
    const prodRes = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: `LSA-SKU-${timestamp}`,
        name: 'Alert Monitored Product',
        price: 49.99,
      })
      .expect(201);

    productId = prodRes.body.id;

    // 5. Initial stock: 10 units
    const adjRes = await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: 10,
      })
      .expect(200);

    inventoryItemId = adjRes.body.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('configures low_stock_threshold via PATCH /inventory/items/:id/threshold', async () => {
    // Configure threshold = 5 (available = 10, so no alert yet)
    const res = await request(app.getHttpServer())
      .patch(`/inventory/items/${inventoryItemId}/threshold`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ low_stock_threshold: 5 })
      .expect(200);

    expect(res.body.low_stock_threshold).toBe(5);

    // Verify 0 OPEN alerts exist
    const alertsRes = await request(app.getHttpServer())
      .get('/alerts/low-stock?status=OPEN')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(alertsRes.body.data).toHaveLength(0);
  });

  it('triggers LowStockAlert when available <= threshold and prevents duplicate OPEN alerts on repeated drops', async () => {
    // Reduce stock by 6 -> on_hand = 4 (available = 4 <= threshold 5) -> Triggers alert
    await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: -6,
      })
      .expect(200);

    const alertsRes1 = await request(app.getHttpServer())
      .get(`/alerts/low-stock?status=OPEN&product_id=${productId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(alertsRes1.body.data).toHaveLength(1);
    const alert1 = alertsRes1.body.data[0];
    expect(alert1.status).toBe('OPEN');
    expect(alert1.current_available).toBe(4);
    expect(alert1.threshold).toBe(5);
    const alertId = alert1.id;

    // Reduce stock further: -2 -> on_hand = 2 (still <= 5)
    // Partial unique index uq_low_stock_alerts_open prevents duplicate OPEN alert, updates current_available
    await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: -2,
      })
      .expect(200);

    const alertsRes2 = await request(app.getHttpServer())
      .get(`/alerts/low-stock?status=OPEN&product_id=${productId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Must still have exactly 1 OPEN alert, with same ID and updated available = 2
    expect(alertsRes2.body.data).toHaveLength(1);
    expect(alertsRes2.body.data[0].id).toBe(alertId);
    expect(alertsRes2.body.data[0].current_available).toBe(2);

    // Verify GET /alerts/low-stock/:id
    const singleAlertRes = await request(app.getHttpServer())
      .get(`/alerts/low-stock/${alertId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(singleAlertRes.body.id).toBe(alertId);
  });

  it('evaluates alert strictly against available (on_hand - reserved), not on_hand alone', async () => {
    // Add 10 units -> on_hand = 12, available = 12 (> 5) -> auto-resolves
    await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: 10,
      })
      .expect(200);

    // Check alert transitioned to RESOLVED
    const resolvedRes = await request(app.getHttpServer())
      .get(`/alerts/low-stock?status=RESOLVED&product_id=${productId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(resolvedRes.body.data.length).toBeGreaterThanOrEqual(1);
    expect(resolvedRes.body.data[0].status).toBe('RESOLVED');
    expect(resolvedRes.body.data[0].resolved_at).toBeDefined();

    // Now simulate on_hand = 12, but reserved = 8 -> available = 4 (<= 5)
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
    await qr.query(`UPDATE inventory_items SET reserved = 8 WHERE id = $1;`, [inventoryItemId]);
    await qr.commitTransaction();
    await qr.release();

    // Trigger evaluation via threshold update to same threshold 5
    await request(app.getHttpServer())
      .patch(`/inventory/items/${inventoryItemId}/threshold`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ low_stock_threshold: 5 })
      .expect(200);

    // An OPEN alert must now exist because available = 4 <= 5 even though on_hand = 12
    const alertsRes = await request(app.getHttpServer())
      .get(`/alerts/low-stock?status=OPEN&product_id=${productId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(alertsRes.body.data).toHaveLength(1);
    expect(alertsRes.body.data[0].current_available).toBe(4);

    // Clean up reserved
    const qr2 = dataSource.createQueryRunner();
    await qr2.connect();
    await qr2.startTransaction();
    await qr2.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
    await qr2.query(`UPDATE inventory_items SET reserved = 0 WHERE id = $1;`, [inventoryItemId]);
    await qr2.commitTransaction();
    await qr2.release();
  });

  it('historical retention: resolved alerts are preserved, and ON DELETE RESTRICT prevents cascade deletion', async () => {
    // Add stock to resolve any open alert
    await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: 10,
      })
      .expect(200);

    const qr = dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const alerts = await qr.query(
        `SELECT id, status FROM low_stock_alerts WHERE tenant_id = $1 AND product_id = $2;`,
        [tenantId, productId],
      );

      expect(alerts.length).toBeGreaterThanOrEqual(1);

      // Verify ON DELETE RESTRICT on product: deleting product with alerts is rejected by DB constraint
      await expect(qr.query(`DELETE FROM products WHERE id = $1;`, [productId])).rejects.toThrow();

      // Verify ON DELETE RESTRICT on warehouse: deleting warehouse with alerts is rejected by DB constraint
      await expect(
        qr.query(`DELETE FROM warehouses WHERE id = $1;`, [warehouseId]),
      ).rejects.toThrow();

      await qr.rollbackTransaction();
    } finally {
      await qr.release();
    }
  });

  it('GET /inventory/movements filters accurately and reserved type=RETURN returns empty list in MVP', async () => {
    // 1. Query all movements for this product
    const allMovRes = await request(app.getHttpServer())
      .get(`/inventory/movements?product_id=${productId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(allMovRes.body.data.length).toBeGreaterThanOrEqual(4);
    expect(allMovRes.body.data[0].product_id).toBe(productId);

    // 2. Query with type=ADJUSTMENT
    const adjMovRes = await request(app.getHttpServer())
      .get(`/inventory/movements?product_id=${productId}&type=ADJUSTMENT`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(adjMovRes.body.data.length).toBeGreaterThanOrEqual(4);

    // 3. Query with reserved type=RETURN: in MVP, returns empty list
    const returnMovRes = await request(app.getHttpServer())
      .get(`/inventory/movements?type=RETURN`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(returnMovRes.body.data).toHaveLength(0);
    expect(returnMovRes.body.total).toBe(0);
  });
});
