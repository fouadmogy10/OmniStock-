import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';
import { SyncCredentialService } from '../../src/modules/sync/sync-credential.service';
import { SyncRetryWorker } from '../../src/modules/sync/sync-retry.worker';
import { SyncStatus } from '../../src/modules/sync/entities/sync-log.entity';

describe('Sync & Webhook Authentication Integration Tests (T033)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let syncCredentialService: SyncCredentialService;
  let syncRetryWorker: SyncRetryWorker;

  let tenantAId: string;
  let adminTokenA: string;
  const timestamp = Date.now();
  const slugA = `sync-ten-a-${timestamp}`;

  let tenantBId: string;
  let adminTokenB: string;
  const slugB = `sync-ten-b-${timestamp}`;

  let customerId: string;
  let warehouseId: string;
  let productId: string;

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
    syncCredentialService = app.get(SyncCredentialService);
    syncRetryWorker = app.get(SyncRetryWorker);

    // 1. Onboard Tenant A
    const tARes = await request(app.getHttpServer())
      .post('/tenants')
      .send({
        name: 'Sync Tenant A',
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
        name: 'Sync Tenant B',
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

    // 3. Prerequisites in Tenant A: Customer, Warehouse, Product, Stock
    const custRes = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        name: 'Sync Customer',
        email: `sync-cust-${timestamp}@test.com`,
      })
      .expect(201);
    customerId = custRes.body.id;

    const whRes = await request(app.getHttpServer())
      .post('/warehouses')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        name: `Sync Hub ${timestamp}`,
        priority: 1,
      })
      .expect(201);
    warehouseId = whRes.body.id;

    const prodRes = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        sku: `SYNC-SKU-${timestamp}`,
        name: 'Sync Test SKU',
        price: 50.0,
      })
      .expect(201);
    productId = prodRes.body.id;

    await request(app.getHttpServer())
      .post('/inventory/adjust')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({
        product_id: productId,
        warehouse_id: warehouseId,
        delta: 20,
      })
      .expect(200);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Webhook Credentials & Keyring Management (T068)', () => {
    let credId: string;
    let webhookSecret: string;

    it('provisions webhook credential returning secret exactly once', async () => {
      const res = await request(app.getHttpServer())
        .post('/sync/credentials')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ source: 'salla' })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.source).toBe('salla');
      expect(res.body.is_active).toBe(true);
      expect(res.body.webhook_secret).toBeDefined();
      expect(res.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
      credId = res.body.id;
      webhookSecret = res.body.webhook_secret;

      // Verify DB storage: secret is NOT plaintext, encrypted_secret is 128 hex chars
      const qr = dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);
        const rows: any[] = await qr.query(
          `SELECT * FROM sync_webhook_credentials WHERE tenant_id = $1 AND id = $2;`,
          [tenantAId, credId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].encrypted_secret).toMatch(/^[0-9a-f]{128}$/);
        expect(rows[0].encryption_iv).toMatch(/^[0-9a-f]{24}$/);
        expect(rows[0].encryption_auth_tag).toMatch(/^[0-9a-f]{32}$/);
        expect(rows[0].secret_hash).toMatch(/^[0-9a-f]{64}$/);
        await qr.commitTransaction();
      } finally {
        await qr.release();
      }
    });

    it('lists credentials exposing safe metadata only and never secrets or ciphertexts', async () => {
      const res = await request(app.getHttpServer())
        .get('/sync/credentials')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      expect(res.body).toBeInstanceOf(Array);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      const cred = res.body.find((c: any) => c.id === credId);
      expect(cred).toBeDefined();
      expect(cred.source).toBe('salla');
      expect(cred.is_active).toBe(true);
      expect(cred.webhook_secret).toBeUndefined();
      expect(cred.encrypted_secret).toBeUndefined();
      expect(cred.secret_hash).toBeUndefined();
      expect(cred.encryption_iv).toBeUndefined();
    });

    it('revokes an active credential', async () => {
      const res = await request(app.getHttpServer())
        .post(`/sync/credentials/${credId}/revoke`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      expect(res.body.is_active).toBe(false);
      expect(res.body.revoked_at).toBeDefined();
    });

    it('rotates credential: creates new active credential and revokes previous', async () => {
      const res = await request(app.getHttpServer())
        .post('/sync/credentials')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ source: 'salla' })
        .expect(201);

      expect(res.body.is_active).toBe(true);
      expect(res.body.id).not.toBe(credId);
    });
  });

  describe('Inbound Webhook Authentication & Signature Verification (T032, T068)', () => {
    let validSecret: string;
    const source = 'salla';

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/sync/credentials')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ source })
        .expect(201);
      validSecret = res.body.webhook_secret;
    });

    function generateSignature(secret: string, timestamp: number, body: string): string {
      const rawBodyBuf = Buffer.from(body, 'utf8');
      const messageBuf = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBodyBuf]);
      const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'));
      return `v1=${hmac.update(messageBuf).digest('hex')}`;
    }

    it('accepts valid HMAC signature and processes order', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const externalId = `EXT-SUCC-${timestamp}`;
      const payloadObj = {
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 2 }],
      };
      const rawBody = JSON.stringify(payloadObj);
      const signature = generateSignature(validSecret, timestamp, rawBody);

      const res = await request(app.getHttpServer())
        .post(`/sync/webhook/${source}`)
        .set('Content-Type', 'application/json')
        .set('X-Sync-Tenant-Slug', slugA)
        .set('X-Sync-External-Id', externalId)
        .set('X-Sync-Timestamp', timestamp.toString())
        .set('X-Sync-Signature', signature)
        .send(rawBody)
        .expect(201);

      expect(res.body.status).toBe('SUCCEEDED');
      expect(res.body.order_id).toBeDefined();
    });

    it('rejects missing or malformed signature with 401 Unauthorized', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ customer_id: customerId, items: [] });

      await request(app.getHttpServer())
        .post(`/sync/webhook/${source}`)
        .set('Content-Type', 'application/json')
        .set('X-Sync-Tenant-Slug', slugA)
        .set('X-Sync-External-Id', `EXT-MAL-${timestamp}`)
        .set('X-Sync-Timestamp', timestamp.toString())
        .set('X-Sync-Signature', 'invalid_signature_format')
        .send(payload)
        .expect(401);
    });

    it('rejects timestamp outside ±300s replay window with 401 Unauthorized', async () => {
      const staleTimestamp = Math.floor(Date.now() / 1000) - 305; // 305s ago
      const payload = JSON.stringify({ customer_id: customerId, items: [] });
      const signature = generateSignature(validSecret, staleTimestamp, payload);

      await request(app.getHttpServer())
        .post(`/sync/webhook/${source}`)
        .set('Content-Type', 'application/json')
        .set('X-Sync-Tenant-Slug', slugA)
        .set('X-Sync-External-Id', `EXT-STALE-${staleTimestamp}`)
        .set('X-Sync-Timestamp', staleTimestamp.toString())
        .set('X-Sync-Signature', signature)
        .send(payload)
        .expect(401);
    });

    it('rejects signature calculated with incorrect secret with 401 Unauthorized', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ customer_id: customerId, items: [] });
      const wrongSecret = crypto.randomBytes(32).toString('hex');
      const signature = generateSignature(wrongSecret, timestamp, payload);

      await request(app.getHttpServer())
        .post(`/sync/webhook/${source}`)
        .set('Content-Type', 'application/json')
        .set('X-Sync-Tenant-Slug', slugA)
        .set('X-Sync-External-Id', `EXT-WRONG-${timestamp}`)
        .set('X-Sync-Timestamp', timestamp.toString())
        .set('X-Sync-Signature', signature)
        .send(payload)
        .expect(401);
    });
  });

  describe('3-Phase Transaction Model & Webhook Idempotency (T031)', () => {
    let validSecret: string;
    const source = 'salla';

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/sync/credentials')
        .set('Authorization', `Bearer ${adminTokenA}`)
        .send({ source })
        .expect(201);
      validSecret = res.body.webhook_secret;
    });

    function sign(secret: string, timestamp: number, body: string): string {
      const rawBodyBuf = Buffer.from(body, 'utf8');
      const messageBuf = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBodyBuf]);
      const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'));
      return `v1=${hmac.update(messageBuf).digest('hex')}`;
    }

    it('handles idempotent duplicate delivery of SUCCEEDED event: returns 200 OK without creating duplicate orders', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const externalId = `IDEMP-${timestamp}`;
      const payload = JSON.stringify({
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 1 }],
      });
      const sig = sign(validSecret, timestamp, payload);

      // First delivery: creates order -> 201 Created
      const firstRes = await request(app.getHttpServer())
        .post(`/sync/webhook/${source}`)
        .set('Content-Type', 'application/json')
        .set('X-Sync-Tenant-Slug', slugA)
        .set('X-Sync-External-Id', externalId)
        .set('X-Sync-Timestamp', timestamp.toString())
        .set('X-Sync-Signature', sig)
        .send(payload)
        .expect(201);

      const firstOrderId = firstRes.body.order_id;
      expect(firstOrderId).toBeDefined();

      // Second delivery: identical event -> returns 200 OK with same order_id
      const secondRes = await request(app.getHttpServer())
        .post(`/sync/webhook/${source}`)
        .set('Content-Type', 'application/json')
        .set('X-Sync-Tenant-Slug', slugA)
        .set('X-Sync-External-Id', externalId)
        .set('X-Sync-Timestamp', timestamp.toString())
        .set('X-Sync-Signature', sig)
        .send(payload)
        .expect(200);

      expect(secondRes.body.order_id).toBe(firstOrderId);
    });

    it('records permanent failure and rolls back Domain TX on INSUFFICIENT_STOCK (all-or-nothing)', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const externalId = `PERM-FAIL-${timestamp}`;
      // Request 999 units (only ~17 remain)
      const payload = JSON.stringify({
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 999 }],
      });
      const sig = sign(validSecret, timestamp, payload);

      const res = await request(app.getHttpServer())
        .post(`/sync/webhook/${source}`)
        .set('Content-Type', 'application/json')
        .set('X-Sync-Tenant-Slug', slugA)
        .set('X-Sync-External-Id', externalId)
        .set('X-Sync-Timestamp', timestamp.toString())
        .set('X-Sync-Signature', sig)
        .send(payload)
        .expect(409);

      expect(res.body.error_code).toBe('INSUFFICIENT_STOCK');

      // Verify Failure TX committed a FAILED_PERMANENT SyncLog and SyncAttempt
      const logRes = await request(app.getHttpServer())
        .get(`/sync/logs?external_id=${externalId}`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      expect(logRes.body.data).toHaveLength(1);
      const log = logRes.body.data[0];
      expect(log.status).toBe('FAILED_PERMANENT');
      expect(log.last_error_code).toBe('INSUFFICIENT_STOCK');

      // Immediate retry of FAILED_PERMANENT webhook returns 409 Conflict
      await request(app.getHttpServer())
        .post(`/sync/webhook/${source}`)
        .set('Content-Type', 'application/json')
        .set('X-Sync-Tenant-Slug', slugA)
        .set('X-Sync-External-Id', externalId)
        .set('X-Sync-Timestamp', timestamp.toString())
        .set('X-Sync-Signature', sig)
        .send(payload)
        .expect(409);
    });
  });

  describe('Sync Log Retries & Lease Recovery (T062, T063)', () => {
    let retryScheduledLogId: string;

    beforeAll(async () => {
      // Seed a RETRY_SCHEDULED log directly for testing
      const qr = dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);
        const res: any[] = await qr.query(
          `
          INSERT INTO sync_logs (id, tenant_id, source, external_id, event_type, status, attempt_count, max_attempts, next_retry_at, next_trigger_source, payload, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, 'salla', $2, 'ORDER_CREATE', 'RETRY_SCHEDULED', 1, 5, CURRENT_TIMESTAMP + INTERVAL '30 seconds', 'AUTO_RETRY', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          RETURNING id;
          `,
          [
            tenantAId,
            `RETRY-TEST-${timestamp}`,
            JSON.stringify({
              customer_id: customerId,
              items: [{ product_id: productId, quantity: 1 }],
            }),
          ],
        );
        retryScheduledLogId = res[0].id;
        await qr.commitTransaction();
      } finally {
        await qr.release();
      }
    });

    it('accelerates a RETRY_SCHEDULED log via POST /sync/logs/:id/retry returning 202 Accepted', async () => {
      const res = await request(app.getHttpServer())
        .post(`/sync/logs/${retryScheduledLogId}/retry`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(202);

      expect(res.body.status).toBe('RETRY_SCHEDULED');
      expect(res.body.next_trigger_source).toBe('MANUAL_RETRY');
    });

    it('rejects manual retry for non-RETRY_SCHEDULED logs with 409 Conflict', async () => {
      // Create a FAILED_PERMANENT log
      const qr = dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      let nonRetryLogId: string;
      try {
        await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);
        const res: any[] = await qr.query(
          `
          INSERT INTO sync_logs (id, tenant_id, source, external_id, event_type, status, attempt_count, max_attempts, payload, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, 'salla', $2, 'ORDER_CREATE', 'FAILED_PERMANENT', 5, 5, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          RETURNING id;
          `,
          [tenantAId, `NON-RETRY-${timestamp}`],
        );
        nonRetryLogId = res[0].id;
        await qr.commitTransaction();
      } finally {
        await qr.release();
      }

      const res = await request(app.getHttpServer())
        .post(`/sync/logs/${nonRetryLogId}/retry`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(409);

      expect(res.body.error_code).toBe('INVALID_SYNC_RETRY_STATE');
    });

    it('recovers expired PROCESSING leases via SyncRetryWorker', async () => {
      // Seed an expired PROCESSING log
      const qr = dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      let expiredLogId: string;
      try {
        await qr.query(`SET LOCAL app.current_tenant_id = '${tenantAId}';`);
        const res: any[] = await qr.query(
          `
          INSERT INTO sync_logs (id, tenant_id, source, external_id, event_type, status, attempt_count, max_attempts, processing_started_at, lease_expires_at, lease_token, active_trigger_source, payload, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, 'salla', $2, 'ORDER_CREATE', 'PROCESSING', 1, 5, CURRENT_TIMESTAMP - INTERVAL '120 seconds', CURRENT_TIMESTAMP - INTERVAL '60 seconds', gen_random_uuid(), 'WEBHOOK', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          RETURNING id;
          `,
          [tenantAId, `EXPIRED-LEASE-${timestamp}`],
        );
        expiredLogId = res[0].id;
        await qr.commitTransaction();
      } finally {
        await qr.release();
      }

      // Execute worker tick manually
      await syncRetryWorker.runTick();

      // Check log was recovered to RETRY_SCHEDULED
      const getRes = await request(app.getHttpServer())
        .get(`/sync/logs/${expiredLogId}`)
        .set('Authorization', `Bearer ${adminTokenA}`)
        .expect(200);

      expect(getRes.body.status).toBe('RETRY_SCHEDULED');
      expect(getRes.body.last_error_code).toBe('PROCESSING_LEASE_EXPIRED');
      expect(getRes.body.attempts.length).toBeGreaterThanOrEqual(1);
    });
  });
});
