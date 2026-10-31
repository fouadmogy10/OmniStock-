import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';
import { RateLimiterService } from '../../src/common/services/rate-limiter.service';

describe('Health, Readiness & Rate Limiting Integration Tests (T071, T034)', () => {
  let app: INestApplication;
  let rateLimiterService: RateLimiterService;

  beforeAll(async () => {
    // Set tight rate limit thresholds for fast testing
    process.env.RATE_LIMIT_TTL_SECONDS = '60';
    process.env.RATE_LIMIT_TENANT_ONBOARD_MAX = '3';
    process.env.RATE_LIMIT_LOGIN_MAX = '3';
    process.env.RATE_LIMIT_WEBHOOK_IP_MAX = '3';

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

    // Setup Swagger
    const swaggerConfig = new DocumentBuilder()
      .setTitle('OmniStock API')
      .setVersion('1.0.0')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);

    await app.init();
    rateLimiterService = app.get(RateLimiterService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    rateLimiterService.reset();
  });

  describe('Health Probes (T071, FR-022)', () => {
    it('GET /health/live returns 200 OK with { status: "ok" } and echoes X-Request-Id', async () => {
      const customReqId = 'health-req-id-12345';
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .set('X-Request-Id', customReqId)
        .expect(200);

      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['x-request-id']).toBe(customReqId);
    });

    it('GET /health/ready returns 200 OK with { status: "ready" } over runtime DB connection', async () => {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(200);

      expect(res.body).toEqual({ status: 'ready' });
    });
  });

  describe('Swagger Documentation (T034)', () => {
    it('GET /api/docs returns 200 OK HTML UI', async () => {
      const res = await request(app.getHttpServer()).get('/api/docs').expect(200);

      expect(res.text).toContain('Swagger UI');
      expect(res.text).toContain('swagger-ui');

      const jsonRes = await request(app.getHttpServer()).get('/api/docs-json').expect(200);

      expect(jsonRes.body.info.title).toBe('OmniStock API');
    });
  });

  describe('Endpoint Rate Limiting (T071, FR-020)', () => {
    it('POST /tenants enforces rate limiting: returns 429 RATE_LIMIT_EXCEEDED with Retry-After header', async () => {
      const tenantData = {
        name: 'Rate Limit Test Tenant',
        slug: `rl-ten-${Date.now()}`,
        admin_email: `admin-${Date.now()}@test.com`,
        admin_password: 'Password123!',
      };

      // Requests 1..3 succeed
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/tenants')
          .send({
            ...tenantData,
            slug: `${tenantData.slug}-${i}`,
            admin_email: `admin-${i}-${tenantData.admin_email}`,
          })
          .expect(201);
      }

      // Request 4 exceeds RATE_LIMIT_TENANT_ONBOARD_MAX (3) -> returns 429
      const res429 = await request(app.getHttpServer())
        .post('/tenants')
        .send({
          ...tenantData,
          slug: `${tenantData.slug}-exceeded`,
          admin_email: `exceeded-${tenantData.admin_email}`,
        })
        .expect(429);

      expect(res429.body.error_code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res429.headers['retry-after']).toBeDefined();
      expect(Number(res429.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('POST /auth/login enforces account rate limiting: returns 429 after threshold', async () => {
      const loginPayload = {
        tenant_slug: 'some-tenant',
        email: 'attacker@target.com',
        password: 'WrongPassword!',
      };

      // Requests 1..3 reach the limit
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer()).post('/auth/login').send(loginPayload).expect(401);
      }

      // Request 4 is blocked by rate limiter with 429
      const res429 = await request(app.getHttpServer())
        .post('/auth/login')
        .send(loginPayload)
        .expect(429);

      expect(res429.body.error_code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res429.headers['retry-after']).toBeDefined();
    });

    it('POST /sync/webhook/:source enforces pre-authentication IP rate limiting before signature checks', async () => {
      // 3 unauthenticated / forged requests
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer()).post('/sync/webhook/salla').send({}).expect(401);
      }

      // 4th request from same IP is blocked with 429 before checking HMAC
      const res429 = await request(app.getHttpServer())
        .post('/sync/webhook/salla')
        .send({})
        .expect(429);

      expect(res429.body.error_code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res429.headers['retry-after']).toBeDefined();
    });
  });
});
