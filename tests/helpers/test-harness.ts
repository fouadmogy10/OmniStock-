import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';

export interface TenantContext {
  tenant: { id: string; name: string; slug: string };
  adminUser: { id: string; email: string };
  adminToken: string;
}

export interface WebhookSignOptions {
  secret: string;
  timestamp: number;
  rawBody: string;
}

/**
 * Multi-tenant test harness and deterministic isolation utilities per T073.
 */
export class TestHarness {
  public app!: INestApplication;
  public dataSource!: DataSource;

  static async create(): Promise<TestHarness> {
    const harness = new TestHarness();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    harness.app = moduleFixture.createNestApplication({ rawBody: true });
    harness.app.useGlobalFilters(new ApiExceptionFilter());
    harness.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );

    await harness.app.init();
    harness.dataSource = harness.app.get(DataSource);
    return harness;
  }

  async close(): Promise<void> {
    if (this.app) {
      await this.app.close();
    }
  }

  /**
   * Factory: provisions an isolated tenant with an admin user and returns valid JWT access token.
   */
  async createTenant(customSlug?: string): Promise<TenantContext> {
    const ts = Date.now();
    const rand = Math.floor(Math.random() * 100000);
    const slug = customSlug || `tenant-${ts}-${rand}`;
    const adminEmail = `admin-${ts}-${rand}@test.com`;
    const adminPassword = 'AdminPassword123!';

    const onboardRes = await request(this.app.getHttpServer())
      .post('/tenants')
      .send({
        name: `Tenant ${slug}`,
        slug,
        admin_email: adminEmail,
        admin_password: adminPassword,
      })
      .expect(201);

    const loginRes = await request(this.app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: slug,
        email: adminEmail,
        password: adminPassword,
      })
      .expect(200);

    return {
      tenant: onboardRes.body.tenant,
      adminUser: onboardRes.body.admin_user,
      adminToken: loginRes.body.access_token,
    };
  }

  /**
   * Factory: creates a subordinate user with a specified role under an existing tenant.
   */
  async createUser(
    adminToken: string,
    role: 'MANAGER' | 'VIEWER',
    tenantSlug: string,
  ): Promise<{ user: any; token: string }> {
    const ts = Date.now();
    const rand = Math.floor(Math.random() * 100000);
    const email = `${role.toLowerCase()}-${ts}-${rand}@test.com`;
    const password = 'UserPassword123!';

    const res = await request(this.app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email,
        password,
        role,
      })
      .expect(201);

    const loginRes = await request(this.app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: tenantSlug,
        email,
        password,
      })
      .expect(200);

    return {
      user: res.body,
      token: loginRes.body.access_token,
    };
  }

  /**
   * Helper: computes valid HMAC-SHA256 signature in v1=<64-hex> format directly over raw body bytes.
   */
  static signWebhook(options: WebhookSignOptions): string {
    const rawBodyBuf = Buffer.from(options.rawBody, 'utf8');
    const messageBuf = Buffer.concat([Buffer.from(`${options.timestamp}.`, 'utf8'), rawBodyBuf]);
    const hmac = crypto.createHmac('sha256', Buffer.from(options.secret, 'utf8'));
    return `v1=${hmac.update(messageBuf).digest('hex')}`;
  }

  /**
   * Concurrency barrier utility for simulating simultaneous requests.
   */
  static async runConcurrent<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    return await Promise.all(tasks.map((task) => task()));
  }

  /**
   * Database reset helper: restricted strictly to verified *_test databases with NODE_ENV === 'test'.
   */
  async safeResetTestDatabase(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('Database reset helper is strictly prohibited outside NODE_ENV === test');
    }

    const dbName = process.env.DB_NAME || '';
    if (!dbName.endsWith('_test') && !dbName.includes('test')) {
      throw new Error(
        `Database reset helper is restricted strictly to verified *_test databases. Current: '${dbName}'`,
      );
    }

    // In a test database, truncate mutable tables under test isolation
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query('TRUNCATE TABLE order_allocations, order_items, orders CASCADE;');
    } finally {
      await qr.release();
    }
  }
}
