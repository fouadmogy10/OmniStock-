import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as crypto from 'crypto';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';
import { RateLimiterService } from '../../src/common/services/rate-limiter.service';
import { DataSource } from 'typeorm';

describe('Operational Rate Limiting Verification', () => {
  let app: INestApplication;
  let rateLimiterService: RateLimiterService;
  let dataSource: DataSource;

  beforeAll(async () => {
    // Configure distinct and tight rate limits
    process.env.RATE_LIMIT_TTL_SECONDS = '60';
    process.env.RATE_LIMIT_TENANT_ONBOARD_MAX = '2';
    process.env.RATE_LIMIT_LOGIN_MAX = '2';
    process.env.RATE_LIMIT_WEBHOOK_IP_MAX = '2';
    process.env.RATE_LIMIT_WEBHOOK_TENANT_MAX = '2';

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
    rateLimiterService = app.get(RateLimiterService);
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    rateLimiterService.reset();
  });

  describe('1. Tenant Onboarding Rate Limiting (POST /tenants)', () => {
    it('enforces limit, returns 429 RATE_LIMIT_EXCEEDED with Retry-After, and allows requests after window expires', async () => {
      const basePayload = {
        name: 'RateLimit Tenant',
        admin_password: 'Password123!',
      };

      // Requests 1 & 2 succeed
      for (let i = 1; i <= 2; i++) {
        const unique = `${Date.now()}-${i}`;
        const res = await request(app.getHttpServer())
          .post('/tenants')
          .send({
            ...basePayload,
            slug: `rl-onboard-${unique}`,
            admin_email: `admin-${unique}@test.com`,
          })
          .expect(201);
        expect(res.body.tenant.slug).toBe(`rl-onboard-${unique}`);
      }

      // Request 3 exceeds limit -> 429
      const exceeded = await request(app.getHttpServer())
        .post('/tenants')
        .send({
          ...basePayload,
          slug: `rl-onboard-exceeded-${Date.now()}`,
          admin_email: `admin-exceeded-${Date.now()}@test.com`,
        })
        .expect(429);

      expect(exceeded.body.statusCode).toBe(429);
      expect(exceeded.body.error_code).toBe('RATE_LIMIT_EXCEEDED');
      expect(exceeded.body.message).toBe('Rate limit exceeded, please retry later');
      expect(exceeded.headers['retry-after']).toBeDefined();
      expect(Number(exceeded.headers['retry-after'])).toBeGreaterThan(0);

      // Verify legitimate requests work again after window expiry (simulated via reset)
      rateLimiterService.reset();

      const afterExpiry = await request(app.getHttpServer())
        .post('/tenants')
        .send({
          ...basePayload,
          slug: `rl-onboard-restored-${Date.now()}`,
          admin_email: `admin-restored-${Date.now()}@test.com`,
        })
        .expect(201);

      expect(afterExpiry.body.tenant.id).toBeDefined();
    });
  });

  describe('2. Login Rate Limiting (POST /auth/login)', () => {
    it('enforces composite account limit, returns 429 with Retry-After, and unblocks after expiry', async () => {
      const loginPayload = {
        tenant_slug: 'test-tenant',
        email: 'user@example.com',
        password: 'WrongPassword!',
      };

      // Requests 1 & 2 fail authentication (401)
      for (let i = 1; i <= 2; i++) {
        await request(app.getHttpServer()).post('/auth/login').send(loginPayload).expect(401);
      }

      // Request 3 exceeds limit -> 429
      const res429 = await request(app.getHttpServer())
        .post('/auth/login')
        .send(loginPayload)
        .expect(429);

      expect(res429.body.statusCode).toBe(429);
      expect(res429.body.error_code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res429.headers['retry-after']).toBeDefined();
      expect(Number(res429.headers['retry-after'])).toBeGreaterThan(0);

      // Verify legitimate attempts work again after window expiry
      rateLimiterService.reset();

      const afterExpiry = await request(app.getHttpServer())
        .post('/auth/login')
        .send(loginPayload)
        .expect(401);

      expect(afterExpiry.body.error_code).toBe('AUTH_UNAUTHORIZED');
    });
  });

  describe('3. Pre-Authentication Webhook IP Rate Limiting (POST /sync/webhook/:source)', () => {
    it('enforces pre-auth IP limit before signature verification and unblocks after expiry', async () => {
      // 2 unauthenticated requests blocked with 401 at auth guard
      for (let i = 1; i <= 2; i++) {
        await request(app.getHttpServer()).post('/sync/webhook/salla').send({}).expect(401);
      }

      // 3rd request is blocked with 429 by RateLimitGuard BEFORE reaching WebhookSignatureGuard
      const res429 = await request(app.getHttpServer())
        .post('/sync/webhook/salla')
        .send({})
        .expect(429);

      expect(res429.body.statusCode).toBe(429);
      expect(res429.body.error_code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res429.headers['retry-after']).toBeDefined();

      // Reset and verify requests reach auth guard again
      rateLimiterService.reset();

      const afterExpiry = await request(app.getHttpServer())
        .post('/sync/webhook/salla')
        .send({})
        .expect(401);

      expect(afterExpiry.body.error_code).toBe('WEBHOOK_AUTH_UNAUTHORIZED');
    });
  });

  describe('4. Post-HMAC Tenant-Level Webhook Rate Limiting (POST /sync/webhook/:source)', () => {
    it('enforces tenant-specific limit post-HMAC without affecting other tenants, and unblocks after expiry', async () => {
      // 1. Create Tenant A and Tenant B
      const tenantA = await request(app.getHttpServer())
        .post('/tenants')
        .send({
          name: 'Tenant A Rate Limit',
          slug: `tenant-a-${Date.now()}`,
          admin_email: `admin-a-${Date.now()}@test.com`,
          admin_password: 'Password123!',
        })
        .expect(201);

      const tenantB = await request(app.getHttpServer())
        .post('/tenants')
        .send({
          name: 'Tenant B Rate Limit',
          slug: `tenant-b-${Date.now()}`,
          admin_email: `admin-b-${Date.now()}@test.com`,
          admin_password: 'Password123!',
        })
        .expect(201);

      // Authenticate Admins
      const loginA = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          tenant_slug: tenantA.body.tenant.slug,
          email: tenantA.body.admin_user.email,
          password: 'Password123!',
        })
        .expect(200);

      const loginB = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          tenant_slug: tenantB.body.tenant.slug,
          email: tenantB.body.admin_user.email,
          password: 'Password123!',
        })
        .expect(200);

      // Create Webhook Credentials for Salla
      const credA = await request(app.getHttpServer())
        .post('/sync/credentials')
        .set('Authorization', `Bearer ${loginA.body.access_token}`)
        .send({ source: 'salla' })
        .expect(201);

      const credB = await request(app.getHttpServer())
        .post('/sync/credentials')
        .set('Authorization', `Bearer ${loginB.body.access_token}`)
        .send({ source: 'salla' })
        .expect(201);

      const secretA = credA.body.webhook_secret;
      const secretB = credB.body.webhook_secret;

      // Helper to send a signed webhook
      const sendSignedWebhook = (
        slug: string,
        secret: string,
        extId: string,
        ip: string = '10.0.0.1',
      ) => {
        const timestamp = Math.floor(Date.now() / 1000);
        const payload = JSON.stringify({
          customer: { name: 'Customer Test', email: 'c@test.com' },
          items: [{ sku: 'NONEXISTENT', quantity: 1 }],
        });
        const rawBodyBuf = Buffer.from(payload, 'utf8');
        const messageBuf = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBodyBuf]);
        const sig =
          'v1=' +
          crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(messageBuf).digest('hex');

        return request(app.getHttpServer())
          .post('/sync/webhook/salla')
          .set('X-Sync-Tenant-Slug', slug)
          .set('X-Sync-External-Id', extId)
          .set('X-Sync-Timestamp', timestamp.toString())
          .set('X-Sync-Signature', sig)
          .set('Content-Type', 'application/json')
          .set('X-Forwarded-For', ip)
          .send(payload);
      };

      // Set high pre-auth limit so only post-HMAC tenant limit triggers
      process.env.RATE_LIMIT_WEBHOOK_IP_MAX = '100';
      rateLimiterService.reset();

      // Tenant A: 2 valid requests pass HMAC and consume Tenant A quota
      const resA1 = await sendSignedWebhook(
        tenantA.body.tenant.slug,
        secretA,
        'EXT-A-001',
        '10.1.1.1',
      );
      expect([200, 201, 202, 400, 404, 409]).toContain(resA1.status);
      expect(resA1.status).not.toBe(429);

      const resA2 = await sendSignedWebhook(
        tenantA.body.tenant.slug,
        secretA,
        'EXT-A-002',
        '10.1.1.2',
      );
      expect([200, 201, 202, 400, 404, 409]).toContain(resA2.status);
      expect(resA2.status).not.toBe(429);

      // Tenant A: 3rd request exceeds RATE_LIMIT_WEBHOOK_TENANT_MAX (2) -> returns 429
      const resA3 = await sendSignedWebhook(
        tenantA.body.tenant.slug,
        secretA,
        'EXT-A-003',
        '10.1.1.3',
      );
      expect(resA3.status).toBe(429);
      expect(resA3.body.error_code).toBe('RATE_LIMIT_EXCEEDED');
      expect(resA3.headers['retry-after']).toBeDefined();

      // Tenant B: completely unaffected by Tenant A's exhausted quota!
      const resB1 = await sendSignedWebhook(
        tenantB.body.tenant.slug,
        secretB,
        'EXT-B-001',
        '10.2.2.1',
      );
      expect([200, 201, 202, 400, 404, 409]).toContain(resB1.status);
      expect(resB1.status).not.toBe(429);

      // Tenant A unblocks after window expiry
      rateLimiterService.reset();

      const resAAfter = await sendSignedWebhook(
        tenantA.body.tenant.slug,
        secretA,
        'EXT-A-004',
        '10.1.1.4',
      );
      expect([200, 201, 202, 400, 404, 409]).toContain(resAAfter.status);
      expect(resAAfter.status).not.toBe(429);
    });
  });
});
