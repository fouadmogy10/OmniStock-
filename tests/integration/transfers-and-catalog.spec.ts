import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';

describe('Transfers & Catalog Integration Tests (T051)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let tenantId: string;

  const timestamp = Date.now();
  const tenantSlug = `tc-test-${timestamp}`;

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

    // Onboard tenant
    const onboardRes = await request(app.getHttpServer())
      .post('/tenants')
      .send({
        name: 'Transfers & Catalog Tenant',
        slug: tenantSlug,
        admin_email: `admin-${timestamp}@tctest.com`,
        admin_password: 'AdminPassword123!',
      })
      .expect(201);

    tenantId = onboardRes.body.tenant.id;

    // Login
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: tenantSlug,
        email: `admin-${timestamp}@tctest.com`,
        password: 'AdminPassword123!',
      })
      .expect(200);

    adminToken = loginRes.body.access_token;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Categories CRUD & Uniqueness', () => {
    let categoryId: string;

    it('creates category and rejects duplicate case-insensitive name', async () => {
      const res = await request(app.getHttpServer())
        .post('/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Electronics',
          description: 'Electronic devices',
        })
        .expect(201);

      categoryId = res.body.id;
      expect(res.body.name).toBe('Electronics');

      // Duplicate name (case-insensitive) -> 409
      const dupRes = await request(app.getHttpServer())
        .post('/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'electronics',
        })
        .expect(409);

      expect(dupRes.body.error_code).toBe('DUPLICATE_CATEGORY_NAME');
    });

    it('lists categories and updates category', async () => {
      const listRes = await request(app.getHttpServer())
        .get('/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(listRes.body).toBeInstanceOf(Array);
      expect(listRes.body.length).toBeGreaterThanOrEqual(1);

      const updateRes = await request(app.getHttpServer())
        .patch(`/categories/${categoryId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ description: 'Updated electronics description' })
        .expect(200);

      expect(updateRes.body.description).toBe('Updated electronics description');
    });
  });

  describe('Products, Variants & Barcode Uniqueness', () => {
    let parentId: string;
    let variant1Id: string;
    let standaloneId: string;

    it('creates variant parent container and child variants with barcode uniqueness', async () => {
      // 1. Create Variant Parent
      const parentRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: `PARENT-${timestamp}`,
          name: 'T-Shirt Master',
          price: 29.99,
          is_variant_parent: true,
        })
        .expect(201);

      parentId = parentRes.body.id;
      expect(parentRes.body.is_variant_parent).toBe(true);

      // 2. Child variant with barcode
      const v1Res = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: `TSHIRT-RED-M-${timestamp}`,
          name: 'T-Shirt Red Medium',
          parent_product_id: parentId,
          is_variant_parent: false,
          barcode: `BAR-${timestamp}-01`,
          variant_attributes: { color: 'Red', size: 'M' },
          price: 29.99,
        })
        .expect(201);

      variant1Id = v1Res.body.id;
      expect(v1Res.body.barcode).toBe(`BAR-${timestamp}-01`);

      // 3. Child variant with duplicate barcode -> 409
      const dupBarcodeRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: `TSHIRT-BLUE-L-${timestamp}`,
          name: 'T-Shirt Blue Large',
          parent_product_id: parentId,
          barcode: `BAR-${timestamp}-01`,
          price: 29.99,
        })
        .expect(409);

      expect(dupBarcodeRes.body.error_code).toBe('DUPLICATE_PRODUCT_BARCODE');

      // 4. Standalone product with null barcode succeeds
      const standRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: `STANDALONE-${timestamp}`,
          name: 'Standalone Cap',
          price: 15.0,
          barcode: null,
        })
        .expect(201);

      standaloneId = standRes.body.id;
      expect(standRes.body.barcode).toBeNull();
    });

    it('rejects price < 0 and multi-level variant nesting', async () => {
      // Negative price
      const negPriceRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: `NEG-PRICE-${timestamp}`,
          name: 'Bad Price Product',
          price: -10,
        })
        .expect(400);

      expect(negPriceRes.body.error_code).toBe('VALIDATION_ERROR');

      // Multi-level variant nesting (child attempting to be parent)
      const multiRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: `MULTI-NEST-${timestamp}`,
          name: 'Nested Parent',
          parent_product_id: parentId,
          is_variant_parent: true,
          price: 20,
        })
        .expect(400);

      expect(multiRes.body.error_code).toBe('VALIDATION_ERROR');
    });

    it('GET /products/:id returns variants array for variant parent', async () => {
      const getRes = await request(app.getHttpServer())
        .get(`/products/${parentId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(getRes.body.is_variant_parent).toBe(true);
      expect(getRes.body.variants).toBeInstanceOf(Array);
      expect(getRes.body.variants.length).toBeGreaterThanOrEqual(1);
      expect(getRes.body.variants[0].id).toBe(variant1Id);
    });
  });

  describe('Warehouses & Active Stock Commitment Guard', () => {
    let wh1Id: string;
    let wh2Id: string;
    let testProductId: string;

    it('creates warehouses with priority ordering and rejects duplicate names', async () => {
      const wh1Res = await request(app.getHttpServer())
        .post('/warehouses')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `Hub-Primary-${timestamp}`,
          location: 'Riyadh',
          priority: 1,
        })
        .expect(201);

      wh1Id = wh1Res.body.id;

      const wh2Res = await request(app.getHttpServer())
        .post('/warehouses')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `Hub-Secondary-${timestamp}`,
          location: 'Jeddah',
          priority: 2,
        })
        .expect(201);

      wh2Id = wh2Res.body.id;

      // Duplicate name
      const dupWhRes = await request(app.getHttpServer())
        .post('/warehouses')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `hub-primary-${timestamp}`,
          priority: 5,
        })
        .expect(409);

      expect(dupWhRes.body.error_code).toBe('DUPLICATE_WAREHOUSE_NAME');

      // Check priority ordering
      const listWhRes = await request(app.getHttpServer())
        .get('/warehouses')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(listWhRes.body[0].priority).toBeLessThanOrEqual(listWhRes.body[1].priority);
    });

    it('enforces active stock commitment guard on warehouse deactivation (A5-3)', async () => {
      // 1. Create a product and allocate stock to wh1
      const prodRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: `WH-GUARD-SKU-${timestamp}`,
          name: 'Warehouse Guard Product',
          price: 50.0,
        })
        .expect(201);

      testProductId = prodRes.body.id;

      await request(app.getHttpServer())
        .post('/inventory/adjust')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          product_id: testProductId,
          warehouse_id: wh1Id,
          delta: 10,
        })
        .expect(200);

      // Simulate a reserved stock commitment on wh1
      const qr = dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
      await qr.query(
        `UPDATE inventory_items SET reserved = 3 WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3;`,
        [tenantId, wh1Id, testProductId],
      );
      await qr.commitTransaction();
      await qr.release();

      // Deactivation must be rejected with 409 WAREHOUSE_HAS_ACTIVE_STOCK_COMMITMENTS
      const deactRes = await request(app.getHttpServer())
        .patch(`/warehouses/${wh1Id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_active: false })
        .expect(409);

      expect(deactRes.body.error_code).toBe('WAREHOUSE_HAS_ACTIVE_STOCK_COMMITMENTS');

      // Clear the reserved stock
      const qr2 = dataSource.createQueryRunner();
      await qr2.connect();
      await qr2.startTransaction();
      await qr2.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
      await qr2.query(
        `UPDATE inventory_items SET reserved = 0 WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3;`,
        [tenantId, wh1Id, testProductId],
      );
      await qr2.commitTransaction();
      await qr2.release();

      // Now deactivation succeeds
      const deactSuccess = await request(app.getHttpServer())
        .patch(`/warehouses/${wh1Id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_active: false })
        .expect(200);

      expect(deactSuccess.body.is_active).toBe(false);

      // Re-activate warehouse for subsequent transfer tests
      await request(app.getHttpServer())
        .patch(`/warehouses/${wh1Id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_active: true })
        .expect(200);
    });
  });

  describe('StockTransfer Complete Lifecycle', () => {
    let srcWhId: string;
    let destWhId: string;
    let transferProdId: string;
    let transferId: string;

    beforeAll(async () => {
      const whs = await request(app.getHttpServer())
        .get('/warehouses')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      srcWhId = whs.body[0].id;
      destWhId = whs.body[1].id;

      const pRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: `TRANSFER-SKU-${timestamp}`,
          name: 'Transfer Item SKU',
          price: 100,
        })
        .expect(201);

      transferProdId = pRes.body.id;

      // Seed 25 units in source warehouse
      await request(app.getHttpServer())
        .post('/inventory/adjust')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          product_id: transferProdId,
          warehouse_id: srcWhId,
          delta: 25,
        })
        .expect(200);
    });

    it('creates DRAFT transfer, dispatches (DRAFT -> IN_TRANSIT), and receives (IN_TRANSIT -> RECEIVED)', async () => {
      // 1. Create DRAFT transfer of 10 units
      const createRes = await request(app.getHttpServer())
        .post('/transfers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          source_warehouse_id: srcWhId,
          destination_warehouse_id: destWhId,
          notes: 'Inter-hub replenishment',
          items: [{ product_id: transferProdId, quantity: 10 }],
        })
        .expect(201);

      expect(createRes.body.status).toBe('DRAFT');
      expect(createRes.body.items).toHaveLength(1);
      transferId = createRes.body.id;

      // 2. Dispatch transfer -> IN_TRANSIT
      const dispatchRes = await request(app.getHttpServer())
        .post(`/transfers/${transferId}/dispatch`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(dispatchRes.body.status).toBe('IN_TRANSIT');
      expect(dispatchRes.body.dispatched_at).toBeDefined();

      // Verify stock: source on_hand = 15, dest in_transit = 10 (dest on_hand = 0, available = 0)
      const levelsRes = await request(app.getHttpServer())
        .get(`/inventory/levels?product_id=${transferProdId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const srcLevel = levelsRes.body.data.find((i: any) => i.warehouse_id === srcWhId);
      const destLevel = levelsRes.body.data.find((i: any) => i.warehouse_id === destWhId);

      expect(srcLevel.on_hand).toBe(15);
      expect(srcLevel.available).toBe(15);

      expect(destLevel.in_transit).toBe(10);
      expect(destLevel.on_hand).toBe(0);
      expect(destLevel.available).toBe(0); // in_transit NEVER inflates available

      // 3. Repeated dispatch rejected with 409 INVALID_TRANSFER_TRANSITION
      const dupDispatchRes = await request(app.getHttpServer())
        .post(`/transfers/${transferId}/dispatch`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      expect(dupDispatchRes.body.error_code).toBe('INVALID_TRANSFER_TRANSITION');

      // 4. Cancellation of IN_TRANSIT transfer rejected with 409
      const cancelInTransitRes = await request(app.getHttpServer())
        .post(`/transfers/${transferId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      expect(cancelInTransitRes.body.error_code).toBe('INVALID_TRANSFER_TRANSITION');

      // 5. Receive transfer -> RECEIVED
      const receiveRes = await request(app.getHttpServer())
        .post(`/transfers/${transferId}/receive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(receiveRes.body.status).toBe('RECEIVED');
      expect(receiveRes.body.received_at).toBeDefined();

      // Verify final stock: dest in_transit = 0, dest on_hand = 10, dest available = 10
      const finalLevelsRes = await request(app.getHttpServer())
        .get(`/inventory/levels?product_id=${transferProdId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const destFinal = finalLevelsRes.body.data.find((i: any) => i.warehouse_id === destWhId);
      expect(destFinal.in_transit).toBe(0);
      expect(destFinal.on_hand).toBe(10);
      expect(destFinal.available).toBe(10);
    });

    it('cancels a DRAFT transfer successfully (DRAFT -> CANCELLED)', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/transfers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          source_warehouse_id: srcWhId,
          destination_warehouse_id: destWhId,
          items: [{ product_id: transferProdId, quantity: 2 }],
        })
        .expect(201);

      const draftId = createRes.body.id;

      const cancelRes = await request(app.getHttpServer())
        .post(`/transfers/${draftId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(cancelRes.body.status).toBe('CANCELLED');
      expect(cancelRes.body.cancelled_at).toBeDefined();
    });
  });
});
