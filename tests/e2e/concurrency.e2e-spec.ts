import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';

describe('Concurrency & Anti-Overselling E2E Tests (T029)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let tenantId: string;

  const timestamp = Date.now();
  const slug = `conc-tenant-${timestamp}`;

  beforeAll(async () => {
    jest.setTimeout(45000);

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

    // 1. Onboard Tenant
    const tRes = await request(app.getHttpServer())
      .post('/tenants')
      .send({
        name: 'Concurrency Test Tenant',
        slug,
        admin_email: `admin@${slug}.com`,
        admin_password: 'Password123!',
      })
      .expect(201);
    tenantId = tRes.body.tenant.id;

    // 2. Login
    const lRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: slug,
        email: `admin@${slug}.com`,
        password: 'Password123!',
      })
      .expect(200);
    adminToken = lRes.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('simulates 100 concurrent orders for the last SKU unit and ensures zero overselling', async () => {
    // 1. Create a customer
    const custRes = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'High Concurrency Customer',
        email: 'concurrency@example.com',
      })
      .expect(201);
    const customerId = custRes.body.id;

    // 2. Create an active warehouse
    const whRes = await request(app.getHttpServer())
      .post('/warehouses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Warehouse Last Unit ${timestamp}`,
        priority: 1,
      })
      .expect(201);
    const warehouseId = whRes.body.id;

    // 3. Create a sellable product
    const prodRes = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: `SKU-LAST-UNIT-${timestamp}`,
        name: 'Limited Edition Product',
        price: 999.0,
      })
      .expect(201);
    const productId = prodRes.body.id;

    // 4. Stock EXACTLY 1 unit on hand in the warehouse
    await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: 1,
      })
      .expect(200);

    // Initial check: on_hand: 1, reserved: 0, available: 1
    const initialLevels = await request(app.getHttpServer())
      .get(`/inventory/levels?warehouse_id=${warehouseId}&product_id=${productId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(initialLevels.body.data[0].on_hand).toBe(1);
    expect(initialLevels.body.data[0].reserved).toBe(0);
    expect(initialLevels.body.data[0].available).toBe(1);

    // 5. Fire 100 concurrent order requests for quantity 1 with auto_allocate: true
    const concurrentCount = 100;
    const promises: Promise<request.Response>[] = [];

    for (let i = 0; i < concurrentCount; i++) {
      const p = request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          customer_id: customerId,
          auto_allocate: true,
          items: [{ product_id: productId, quantity: 1 }],
        });
      promises.push(p);
    }

    const results = await Promise.all(promises);

    // 6. Verify response distribution: exactly 1 success (201), exactly 99 conflicts (409)
    const successResponses = results.filter((r) => r.status === 201);
    const conflictResponses = results.filter((r) => r.status === 409);

    expect(successResponses.length).toBe(1);
    expect(conflictResponses.length).toBe(99);

    // Verify error code on all 99 conflicts is INSUFFICIENT_STOCK
    for (const conflict of conflictResponses) {
      expect(conflict.body.error_code).toBe('INSUFFICIENT_STOCK');
    }

    // Verify successful order details
    const wonOrder = successResponses[0].body;
    expect(wonOrder.status).toBe('ALLOCATED');
    expect(wonOrder.items).toHaveLength(1);
    expect(wonOrder.items[0].allocations).toHaveLength(1);
    expect(wonOrder.items[0].allocations[0].allocated_quantity).toBe(1);
    expect(wonOrder.items[0].allocations[0].warehouse_id).toBe(warehouseId);

    // 7. Verify final inventory state: on_hand: 1, reserved: 1, available: 0 (ZERO OVERSELLING)
    const finalLevels = await request(app.getHttpServer())
      .get(`/inventory/levels?warehouse_id=${warehouseId}&product_id=${productId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const item = finalLevels.body.data[0];
    expect(item.on_hand).toBe(1);
    expect(item.reserved).toBe(1);
    expect(item.available).toBe(0);

    // 8. Cancel the allocated order to verify stock recovery
    await request(app.getHttpServer())
      .post(`/orders/${wonOrder.id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const recoveredLevels = await request(app.getHttpServer())
      .get(`/inventory/levels?warehouse_id=${warehouseId}&product_id=${productId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(recoveredLevels.body.data[0].reserved).toBe(0);
    expect(recoveredLevels.body.data[0].available).toBe(1);
  });
});

