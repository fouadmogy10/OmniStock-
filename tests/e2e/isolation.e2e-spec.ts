import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';

describe('Cross-Tenant Isolation E2E Tests (T015)', () => {
  let app: INestApplication;

  let tenant1Id: string;
  let adminToken1: string;
  let user1Id: string;

  let tenant2Id: string;
  let adminToken2: string;
  let user2Id: string;

  const timestamp = Date.now();
  const slug1 = `e2e-tenant-1-${timestamp}`;
  const slug2 = `e2e-tenant-2-${timestamp}`;

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

    // 1. Onboard Tenant 1
    const t1Res = await request(app.getHttpServer())
      .post('/tenants')
      .send({
        name: 'E2E Tenant One',
        slug: slug1,
        admin_email: `admin@${slug1}.com`,
        admin_password: 'Password123!',
      })
      .expect(201);
    tenant1Id = t1Res.body.tenant.id;

    // Login Admin 1
    const l1Res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: slug1,
        email: `admin@${slug1}.com`,
        password: 'Password123!',
      })
      .expect(200);
    adminToken1 = l1Res.body.access_token;

    // 2. Onboard Tenant 2
    const t2Res = await request(app.getHttpServer())
      .post('/tenants')
      .send({
        name: 'E2E Tenant Two',
        slug: slug2,
        admin_email: `admin@${slug2}.com`,
        admin_password: 'Password123!',
      })
      .expect(201);
    tenant2Id = t2Res.body.tenant.id;

    // Login Admin 2
    const l2Res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: slug2,
        email: `admin@${slug2}.com`,
        password: 'Password123!',
      })
      .expect(200);
    adminToken2 = l2Res.body.access_token;

    // 3. Create User in Tenant 1
    const u1Res = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken1}`)
      .send({
        email: `user@${slug1}.com`,
        password: 'UserPass123!',
        role: 'MANAGER',
      })
      .expect(201);
    user1Id = u1Res.body.id;

    // 4. Create User in Tenant 2
    const u2Res = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken2}`)
      .send({
        email: `user@${slug2}.com`,
        password: 'UserPass123!',
        role: 'MANAGER',
      })
      .expect(201);
    user2Id = u2Res.body.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET /tenants/me returns strictly the caller authenticated tenant profile', async () => {
    const me1 = await request(app.getHttpServer())
      .get('/tenants/me')
      .set('Authorization', `Bearer ${adminToken1}`)
      .expect(200);

    expect(me1.body.id).toBe(tenant1Id);
    expect(me1.body.slug).toBe(slug1);

    const me2 = await request(app.getHttpServer())
      .get('/tenants/me')
      .set('Authorization', `Bearer ${adminToken2}`)
      .expect(200);

    expect(me2.body.id).toBe(tenant2Id);
    expect(me2.body.slug).toBe(slug2);
  });

  it('Tenant 1 cannot read Tenant 2 user (returns 404 Not Found due to RLS)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${user2Id}`)
      .set('Authorization', `Bearer ${adminToken1}`)
      .expect(404);

    expect(res.body.error_code).toBe('USER_NOT_FOUND');
  });

  it('Tenant 2 cannot read Tenant 1 user (returns 404 Not Found due to RLS)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${user1Id}`)
      .set('Authorization', `Bearer ${adminToken2}`)
      .expect(404);

    expect(res.body.error_code).toBe('USER_NOT_FOUND');
  });

  it('Tenant 1 cannot update Tenant 2 user (returns 404 Not Found)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${user2Id}`)
      .set('Authorization', `Bearer ${adminToken1}`)
      .send({ role: 'VIEWER' })
      .expect(404);

    expect(res.body.error_code).toBe('USER_NOT_FOUND');
  });

  it('Tenant 1 user list contains only Tenant 1 users and zero Tenant 2 users', async () => {
    const res1 = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${adminToken1}`)
      .expect(200);

    const ids1 = res1.body.data.map((u: any) => u.id);
    expect(ids1).toContain(user1Id);
    expect(ids1).not.toContain(user2Id);

    for (const u of res1.body.data) {
      expect(u.tenant_id).toBe(tenant1Id);
    }
  });

  it('Tenant 1 audit logs contain zero Tenant 2 logs', async () => {
    const auditRes = await request(app.getHttpServer())
      .get('/audit-logs')
      .set('Authorization', `Bearer ${adminToken1}`)
      .expect(200);

    expect(auditRes.body.data).toBeInstanceOf(Array);
    for (const log of auditRes.body.data) {
      expect(log.tenant_id).toBe(tenant1Id);
    }
  });
});
