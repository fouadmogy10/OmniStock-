import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';

describe('Dashboard Integration Tests (T065)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let tenantAId: string;
  let adminTokenA: string;
  let managerTokenA: string;
  let viewerTokenA: string;
  const timestamp = Date.now();
  const slugA = `dash-ten-a-${timestamp}`;

  let tenantBId: string;
  let adminTokenB: string;
  const slugB = `dash-ten-b-${timestamp}`;

  let warehouseA1Id: string;
  let warehouseA2Id: string;
  let warehouseB1Id: string;
  let productA1Id: string;
  let customerAId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new ApiExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();
    dataSource = app.get(DataSource);

    // 1. Onboard Tenant A
    const tARes = await request(app.getHttpServer())
      .post('/tenants')
      .send({
        name: 'Dashboard Tenant A',
        slug: slugA,
        admin_email: `admin@${slugA}.com`,
        admin_password: 'Password123!',
      })
      .expect(201);
    tenantAId = tARes.body.tenant.id;

    const lARes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: slugA,
        email: `admin@${slugA}.com`,
        password: 'Password123!',
      })
      .expect(200);
    adminTokenA = lARes.body.access_token;

    // Create Manager user in Tenant A
    await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        email: `manager@${slugA}.com`,
        password: 'Password123!',
        role: 'MANAGER',
      })
      .expect(201);

    const lMgrRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: slugA,
        email: `manager@${slugA}.com`,
        password: 'Password123!',
      })
      .expect(200);
    managerTokenA = lMgrRes.body.access_token;

    // Create Viewer user in Tenant A
    await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        email: `viewer@${slugA}.com`,
        password: 'Password123!',
        role: 'VIEWER',
      })
      .expect(201);

    const lVwrRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: slugA,
        email: `viewer@${slugA}.com`,
        password: 'Password123!',
      })
      .expect(200);
    viewerTokenA = lVwrRes.body.access_token;

    // 2. Onboard Tenant B
    const tBRes = await request(app.getHttpServer())
      .post('/tenants')
      .send({
        name: 'Dashboard Tenant B',
        slug: slugB,
        admin_email: `admin@${slugB}.com`,
        admin_password: 'Password123!',
      })
      .expect(201);
    tenantBId = tBRes.body.tenant.id;

    const lBRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: slugB,
        email: `admin@${slugB}.com`,
        password: 'Password123!',
      })
      .expect(200);
    adminTokenB = lBRes.body.access_token;

    // 3. Seed Warehouses for Tenant A
    const whA1Res = await request(app.getHttpServer())
      .post('/warehouses')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        name: 'Warehouse A1',
        location: 'Location 1',
        priority: 1,
      })
      .expect(201);
    warehouseA1Id = whA1Res.body.id;

    const whA2Res = await request(app.getHttpServer())
      .post('/warehouses')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        name: 'Warehouse A2',
        location: 'Location 2',
        priority: 2,
      })
      .expect(201);
    warehouseA2Id = whA2Res.body.id;

    // Seed Warehouse for Tenant B
    const whB1Res = await request(app.getHttpServer())
      .post('/warehouses')
      .set('Authorization', `Bearer ${adminTokenB}`)
      .send({
        name: 'Warehouse B1',
        location: 'Location B1',
        priority: 1,
      })
      .expect(201);
    warehouseB1Id = whB1Res.body.id;

    // 4. Seed Product in Tenant A
    const prodA1Res = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        name: 'Phone A1',
        sku: `SKU-A1-${timestamp}`,
        price: 500.0,
      })
      .expect(201);
    productA1Id = prodA1Res.body.id;

    // Create an inactive product in Tenant A
    const inactProdRes = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        name: 'Inactive Phone',
        sku: `SKU-INACT-${timestamp}`,
        price: 300.0,
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/products/${inactProdRes.body.id}`)
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        is_active: false,
      })
      .expect(200);

    // 5. Seed Customer in Tenant A
    const custRes = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        name: 'Customer A',
        email: `cust-${timestamp}@test.com`,
      })
      .expect(201);
    customerAId = custRes.body.id;

    // 6. Adjust stock for Product A1 in Warehouse A1 (100 units)
    await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        product_id: productA1Id,
        warehouse_id: warehouseA1Id,
        delta: 100,
        reason: 'Initial stock',
      })
      .expect(200);

    // 7. Create and allocate an order in Tenant A (2 units @ 500 = 1000)
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        customer_id: customerAId,
        auto_allocate: true,
        items: [{ product_id: productA1Id, quantity: 2 }],
      })
      .expect(201);
    expect(orderRes.body.status).toBe('ALLOCATED');
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Strict ISO-8601 UTC-Offset Validation (T064, T065)', () => {
    it('rejects date-only strings without time and offset with 400 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-10-01&to=2026-10-31T23:59:59Z')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(400);

      expect(res.body.error_code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toContain('from timestamp must be a valid ISO-8601');
    });

    it('rejects missing timezone offset (e.g. 2026-10-01T00:00:00) with 400 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-10-01T00:00:00&to=2026-10-31T23:59:59Z')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(400);

      expect(res.body.error_code).toBe('VALIDATION_ERROR');
    });

    it('rejects from timestamp greater than to timestamp with 400 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-10-31T00:00:00Z&to=2026-10-01T00:00:00Z')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(400);

      expect(res.body.error_code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toContain('from timestamp cannot be greater than to timestamp');
    });

    it('rejects invalid limit values (< 1 or > 50) with 400 VALIDATION_ERROR', async () => {
      const res1 = await request(app.getHttpServer())
        .get('/dashboard/summary?limit=0')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(400);
      expect(res1.body.error_code).toBe('VALIDATION_ERROR');

      const res2 = await request(app.getHttpServer())
        .get('/dashboard/summary?limit=51')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(400);
      expect(res2.body.error_code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Dashboard Metrics & Filtering Accuracy (T064, T065)', () => {
    it('returns accurate summary with active-only counts and period_order_value breakdown', async () => {
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const res = await request(app.getHttpServer())
        .get(`/dashboard/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      const body = res.body;

      // 1. Period bounds echoed
      expect(body.period.from).toBe(from);
      expect(body.period.to).toBe(to);

      // 2. catalog_and_network: total_products excludes inactive products
      expect(body.catalog_and_network.total_products).toBe(1);
      expect(body.catalog_and_network.total_variant_parents).toBe(0);
      expect(body.catalog_and_network.total_warehouses).toBe(2);
      expect(body.catalog_and_network.total_customers).toBe(1);

      // 3. orders_by_status has all 5 keys
      expect(body.orders_by_status).toEqual({
        DRAFT: 0,
        PENDING: 0,
        ALLOCATED: 1,
        SHIPPED: 0,
        CANCELLED: 0,
      });

      // 4. period_order_value
      expect(body.period_order_value.allocated_order_value).toBe(1000.0);
      expect(body.period_order_value.shipped_order_value).toBe(0.0);
      expect(body.period_order_value.combined_committed_order_value).toBe(1000.0);

      // 5. inventory_quantity_summary (100 on_hand - 2 reserved = 98 available)
      expect(body.inventory_quantity_summary.total_on_hand).toBe(100);
      expect(body.inventory_quantity_summary.total_reserved).toBe(2);
      expect(body.inventory_quantity_summary.total_available).toBe(98);
      expect(body.inventory_quantity_summary.total_in_transit).toBe(0);

      // 6. Explicit exclusion of cost/valuation fields
      expect(JSON.stringify(body)).not.toContain('cost');
      expect(JSON.stringify(body)).not.toContain('valuation');
      expect(JSON.stringify(body)).not.toContain('cost_price');

      // 7. recent_orders and recent_stock_movements arrays
      expect(Array.isArray(body.recent_orders)).toBe(true);
      expect(body.recent_orders.length).toBeGreaterThanOrEqual(1);
      expect(body.recent_orders[0].customer_name_snapshot).toBe('Customer A');
      expect(body.recent_orders[0].total_amount).toBe(1000.0);

      expect(Array.isArray(body.recent_stock_movements)).toBe(true);
      expect(body.recent_stock_movements.length).toBeGreaterThanOrEqual(1);
    });

    it('scopes metrics to warehouse_id when specified', async () => {
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      // Warehouse A1 has inventory
      const resA1 = await request(app.getHttpServer())
        .get(
          `/dashboard/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&warehouse_id=${warehouseA1Id}`,
        )
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      expect(resA1.body.warehouse_id).toBe(warehouseA1Id);
      expect(resA1.body.inventory_quantity_summary.total_on_hand).toBe(100);

      // Warehouse A2 has 0 inventory
      const resA2 = await request(app.getHttpServer())
        .get(
          `/dashboard/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&warehouse_id=${warehouseA2Id}`,
        )
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      expect(resA2.body.warehouse_id).toBe(warehouseA2Id);
      expect(resA2.body.inventory_quantity_summary.total_on_hand).toBe(0);
      expect(resA2.body.inventory_quantity_summary.total_available).toBe(0);
    });

    it('rejects cross-tenant warehouse_id with 404 WAREHOUSE_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer())
        .get(`/dashboard/summary?warehouse_id=${warehouseB1Id}`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(404);

      expect(res.body.error_code).toBe('WAREHOUSE_NOT_FOUND');
    });
  });

  describe('Multi-Tenant Isolation & RBAC (T064, T065)', () => {
    it('isolates Tenant B summary from Tenant A orders and inventory', async () => {
      const resB = await request(app.getHttpServer())
        .get('/dashboard/summary')
        .set('Authorization', `Bearer ${adminTokenB}`)
        .expect(200);

      expect(resB.body.catalog_and_network.total_products).toBe(0);
      expect(resB.body.catalog_and_network.total_warehouses).toBe(1);
      expect(resB.body.catalog_and_network.total_customers).toBe(0);
      expect(resB.body.period_order_value.combined_committed_order_value).toBe(0.0);
      expect(resB.body.inventory_quantity_summary.total_on_hand).toBe(0);
      expect(resB.body.recent_orders).toHaveLength(0);
      expect(resB.body.recent_stock_movements).toHaveLength(0);
    });

    it('allows MANAGER and VIEWER roles to access summary via dashboard:read', async () => {
      await request(app.getHttpServer())
        .get('/dashboard/summary')
        .set('Authorization', `Bearer ${managerTokenA}`)
        .expect(200);

      await request(app.getHttpServer())
        .get('/dashboard/summary')
        .set('Authorization', `Bearer ${viewerTokenA}`)
        .expect(200);
    });

    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      await request(app.getHttpServer()).get('/dashboard/summary').expect(401);
    });
  });
});
