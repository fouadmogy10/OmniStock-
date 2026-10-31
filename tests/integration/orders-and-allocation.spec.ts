import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';

describe('Orders & Allocation Integration Tests (T055)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  // Tenant A
  let tenantAId: string;
  let adminTokenA: string;
  const timestamp = Date.now();
  const slugA = `ord-ten-a-${timestamp}`;

  // Tenant B (for cross-tenant checks)
  let tenantBId: string;
  let adminTokenB: string;
  const slugB = `ord-ten-b-${timestamp}`;

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
        name: 'Order Tenant A',
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

    // 2. Onboard Tenant B
    const tBRes = await request(app.getHttpServer())
      .post('/tenants')
      .send({
        name: 'Order Tenant B',
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
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Customer Management & Tenant Isolation', () => {
    let customerAId: string;

    it('creates customer in Tenant A', async () => {
      const res = await request(app.getHttpServer())
        .post('/customers')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          name: 'Jane Doe',
          email: 'jane.doe@example.com',
          phone: '+966501111111',
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.name).toBe('Jane Doe');
      expect(res.body.email).toBe('jane.doe@example.com');
      expect(res.body.phone).toBe('+966501111111');
      customerAId = res.body.id;
    });

    it('rejects duplicate customer email in Tenant A with 409 Conflict', async () => {
      const res = await request(app.getHttpServer())
        .post('/customers')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          name: 'Jane Duplicate',
          email: 'JANE.DOE@example.com', // Case-insensitive duplicate
        })
        .expect(409);

      expect(res.body.error_code).toBe('DUPLICATE_CUSTOMER_EMAIL');
    });

    it('allows same customer email in Tenant B (tenant-scoped uniqueness)', async () => {
      const res = await request(app.getHttpServer())
        .post('/customers')
        .set('Authorization', `Bearer ${adminTokenB}`)
        .send({
          name: 'Jane Doe in B',
          email: 'jane.doe@example.com',
          phone: '+966502222222',
        })
        .expect(201);

      expect(res.body.tenant_id).toBe(tenantBId);
    });

    it('prevents Tenant B from retrieving Tenant A customer (404 Not Found)', async () => {
      await request(app.getHttpServer())
        .get(`/customers/${customerAId}`)
        .set('Authorization', `Bearer ${adminTokenB}`)
        .expect(404);
    });

    it('lists customers with pagination and search in Tenant A', async () => {
      const res = await request(app.getHttpServer())
        .get('/customers?search=Jane')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
    });

    it('updates customer in Tenant A', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/customers/${customerAId}`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          name: 'Jane Updated',
        })
        .expect(200);

      expect(res.body.name).toBe('Jane Updated');
    });
  });

  describe('Order Lifecycle, Customer Snapshots, and Split Allocation', () => {
    let customerId: string;
    let product1Id: string;
    let product2Id: string;
    let wh1Id: string;
    let wh2Id: string;
    let invItemWh1Id: string;

    beforeAll(async () => {
      // 1. Create Customer
      const custRes = await request(app.getHttpServer())
        .post('/customers')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          name: 'John Snapshot',
          email: 'john.snapshot@example.com',
          phone: '+966503333333',
        })
        .expect(201);
      customerId = custRes.body.id;

      // 2. Create Warehouses: WH1 (priority 1), WH2 (priority 2)
      const wh1Res = await request(app.getHttpServer())
        .post('/warehouses')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          name: `WH1 Priority1 ${timestamp}`,
          priority: 1,
        })
        .expect(201);
      wh1Id = wh1Res.body.id;

      const wh2Res = await request(app.getHttpServer())
        .post('/warehouses')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          name: `WH2 Priority2 ${timestamp}`,
          priority: 2,
        })
        .expect(201);
      wh2Id = wh2Res.body.id;

      // 3. Create Products
      const prod1Res = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          sku: `SKU-ORD-1-${timestamp}`,
          name: 'Order Product 1',
          price: 100.0,
        })
        .expect(201);
      product1Id = prod1Res.body.id;

      const prod2Res = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          sku: `SKU-ORD-2-${timestamp}`,
          name: 'Order Product 2',
          price: 250.0,
        })
        .expect(201);
      product2Id = prod2Res.body.id;

      // 4. Adjust Inventory for Product 1:
      // WH1 has on_hand 5, WH2 has on_hand 7. Total available = 12.
      const adj1 = await request(app.getHttpServer())
        .post('/inventory/adjust')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          product_id: product1Id,
          warehouse_id: wh1Id,
          delta: 5,
        })
        .expect(200);
      invItemWh1Id = adj1.body.id;

      await request(app.getHttpServer())
        .post('/inventory/adjust')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          product_id: product1Id,
          warehouse_id: wh2Id,
          delta: 7,
        })
        .expect(200);
    });

    it('creates DRAFT order when auto_allocate is false with 0 allocations and 0 stock reservations', async () => {
      const res = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          customer_id: customerId,
          auto_allocate: false,
          items: [{ product_id: product1Id, quantity: 3 }],
        })
        .expect(201);

      expect(res.body.status).toBe('DRAFT');
      expect(res.body.customer_name_snapshot).toBe('John Snapshot');
      expect(res.body.customer_email_snapshot).toBe('john.snapshot@example.com');
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].allocations).toHaveLength(0);

      // Verify no reservations occurred
      const invCheck = await request(app.getHttpServer())
        .get('/inventory/levels')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      const wh1Level = invCheck.body.data.find(
        (i: any) => i.warehouse_id === wh1Id && i.product_id === product1Id,
      );
      expect(wh1Level.reserved).toBe(0);
    });

    it('preserves customer snapshot after customer name is updated', async () => {
      // 1. Create order
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          customer_id: customerId,
          auto_allocate: false,
          items: [{ product_id: product1Id, quantity: 2 }],
        })
        .expect(201);

      const orderId = orderRes.body.id;
      expect(orderRes.body.customer_name_snapshot).toBe('John Snapshot');

      // 2. Update Customer name
      await request(app.getHttpServer())
        .patch(`/customers/${customerId}`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          name: 'John NameHasChanged',
        })
        .expect(200);

      // 3. Verify Order snapshot is still the original name
      const getOrderRes = await request(app.getHttpServer())
        .get(`/orders/${orderId}`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      expect(getOrderRes.body.customer_name_snapshot).toBe('John Snapshot');
    });

    it('executes deterministic multi-warehouse split allocation across priority-ordered warehouses', async () => {
      // WH1 (priority 1) has 5 available, WH2 (priority 2) has 7 available.
      // Order requested quantity = 12.
      const res = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          customer_id: customerId,
          auto_allocate: true,
          items: [{ product_id: product1Id, quantity: 12 }],
        })
        .expect(201);

      expect(res.body.status).toBe('ALLOCATED');
      expect(res.body.total_amount).toBe(1200.0);
      expect(res.body.items).toHaveLength(1);

      const allocations = res.body.items[0].allocations;
      expect(allocations).toHaveLength(2);

      // Priority 1 warehouse got 5, Priority 2 warehouse got 7
      const wh1Alloc = allocations.find((a: any) => a.warehouse_id === wh1Id);
      const wh2Alloc = allocations.find((a: any) => a.warehouse_id === wh2Id);
      expect(wh1Alloc.allocated_quantity).toBe(5);
      expect(wh2Alloc.allocated_quantity).toBe(7);

      // Verify inventory reserved counts
      const invCheck = await request(app.getHttpServer())
        .get('/inventory/levels')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      const wh1Level = invCheck.body.data.find(
        (i: any) => i.warehouse_id === wh1Id && i.product_id === product1Id,
      );
      const wh2Level = invCheck.body.data.find(
        (i: any) => i.warehouse_id === wh2Id && i.product_id === product1Id,
      );

      expect(wh1Level.reserved).toBe(5);
      expect(wh1Level.available).toBe(0);
      expect(wh2Level.reserved).toBe(7);
      expect(wh2Level.available).toBe(0);
    });

    it('enforces all-or-nothing rollback on INSUFFICIENT_STOCK with zero partial reservations', async () => {
      // Replenish WH1 by 10
      await request(app.getHttpServer())
        .post('/inventory/adjust')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          product_id: product2Id,
          warehouse_id: wh1Id,
          delta: 10,
        })
        .expect(200);

      // Request 11 units of product2 (only 10 exist)
      const res = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          customer_id: customerId,
          auto_allocate: true,
          items: [{ product_id: product2Id, quantity: 11 }],
        })
        .expect(409);

      expect(res.body.error_code).toBe('INSUFFICIENT_STOCK');

      // Verify 0 reservations were made (all-or-nothing rollback)
      const invCheck = await request(app.getHttpServer())
        .get('/inventory/levels')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      const wh1Prod2 = invCheck.body.data.find(
        (i: any) => i.warehouse_id === wh1Id && i.product_id === product2Id,
      );
      expect(wh1Prod2.reserved).toBe(0);
      expect(wh1Prod2.available).toBe(10);
    });

    it('executes full order lifecycle: DRAFT -> PENDING -> ALLOCATED -> SHIPPED, verifying immutable StockMovement and stock decrement', async () => {
      // 1. Create DRAFT order
      const draftRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          customer_id: customerId,
          auto_allocate: false,
          items: [{ product_id: product2Id, quantity: 4 }],
        })
        .expect(201);
      const orderId = draftRes.body.id;
      expect(draftRes.body.status).toBe('DRAFT');

      // 2. Submit order: DRAFT -> PENDING
      const submitRes = await request(app.getHttpServer())
        .post(`/orders/${orderId}/submit`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      expect(submitRes.body.status).toBe('PENDING');

      // 3. Allocate order: PENDING -> ALLOCATED
      const allocRes = await request(app.getHttpServer())
        .post(`/orders/${orderId}/allocate`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      expect(allocRes.body.status).toBe('ALLOCATED');
      expect(allocRes.body.items[0].allocations).toHaveLength(1);
      expect(allocRes.body.items[0].allocations[0].allocated_quantity).toBe(4);

      // 4. Ship order: ALLOCATED -> SHIPPED
      const shipRes = await request(app.getHttpServer())
        .post(`/orders/${orderId}/ship`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      expect(shipRes.body.status).toBe('SHIPPED');

      // 5. Verify inventory on_hand and reserved are decremented
      const invCheck = await request(app.getHttpServer())
        .get('/inventory/levels')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      const wh1Prod2 = invCheck.body.data.find(
        (i: any) => i.warehouse_id === wh1Id && i.product_id === product2Id,
      );
      expect(wh1Prod2.on_hand).toBe(6); // 10 - 4
      expect(wh1Prod2.reserved).toBe(0); // 4 - 4
      expect(wh1Prod2.available).toBe(6);

      // 6. Verify SALE StockMovement was recorded
      const movRes = await request(app.getHttpServer())
        .get('/inventory/movements')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      const saleMovement = movRes.body.data.find(
        (m: any) => m.reference_id === orderId && m.type === 'SALE',
      );
      expect(saleMovement).toBeDefined();
      expect(saleMovement.delta).toBe(-4);

      // 7. Verify SHIPPED order CANNOT be cancelled
      const cancelRes = await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(409);
      expect(cancelRes.body.error_code).toBe('INVALID_ORDER_TRANSITION');
    });

    it('cancels ALLOCATED order, restores reserved stock, and evaluates LowStockAlert resolution', async () => {
      // 1. Configure low-stock threshold = 5 on WH1 for Product 2 (currently on_hand = 6)
      const invCheckWh1Prod2 = await request(app.getHttpServer())
        .get(`/inventory/levels?warehouse_id=${wh1Id}&product_id=${product2Id}`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      const itemToConfigure = invCheckWh1Prod2.body.data[0];

      await request(app.getHttpServer())
        .patch(`/inventory/items/${itemToConfigure.id}/threshold`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          low_stock_threshold: 5,
        })
        .expect(200);

      // 2. Allocate 2 units of Product 2 -> available becomes 4 (<= 5), which triggers an OPEN alert
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          customer_id: customerId,
          auto_allocate: true,
          items: [{ product_id: product2Id, quantity: 2 }],
        })
        .expect(201);
      const orderId = orderRes.body.id;
      expect(orderRes.body.status).toBe('ALLOCATED');

      // Verify alert is triggered OPEN
      const alertsRes = await request(app.getHttpServer())
        .get('/alerts/low-stock?status=OPEN')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      const openAlert = alertsRes.body.data.find((a: any) => a.product_id === product2Id);
      expect(openAlert).toBeDefined();

      // 3. Cancel the ALLOCATED order
      const cancelRes = await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      expect(cancelRes.body.status).toBe('CANCELLED');

      // 4. Verify reserved stock was released (available restored to 6 > threshold 5)
      const invCheck = await request(app.getHttpServer())
        .get('/inventory/levels')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      const wh1Prod2 = invCheck.body.data.find(
        (i: any) => i.warehouse_id === wh1Id && i.product_id === product2Id,
      );
      expect(wh1Prod2.reserved).toBe(0);
      expect(wh1Prod2.available).toBe(6);

      // 5. Verify alert is auto-resolved
      const alertsResolvedRes = await request(app.getHttpServer())
        .get('/alerts/low-stock?status=RESOLVED')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);
      const resolvedAlert = alertsResolvedRes.body.data.find(
        (a: any) => a.product_id === product2Id,
      );
      expect(resolvedAlert).toBeDefined();
    });

    it('rejects cross-tenant order access and allocation', async () => {
      // 1. Create order in Tenant A
      const orderA = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({
          customer_id: customerId,
          auto_allocate: false,
          items: [{ product_id: product2Id, quantity: 1 }],
        })
        .expect(201);

      // 2. Tenant B attempts to read order A
      await request(app.getHttpServer())
        .get(`/orders/${orderA.body.id}`)
        .set('Authorization', `Bearer ${adminTokenB}`)
        .expect(404);

      // 3. Tenant B attempts to allocate order A
      await request(app.getHttpServer())
        .post(`/orders/${orderA.body.id}/allocate`)
        .set('Authorization', `Bearer ${adminTokenB}`)
        .expect(404);
    });
  });
});
