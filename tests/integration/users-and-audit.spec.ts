import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';

describe('Users & Audit Integration Tests (T067)', () => {
  let app: INestApplication;
  let adminToken: string;
  let tenantId: string;
  let adminId: string;
  let managerId: string;
  let managerToken: string;

  const tenantSlug = `audit-test-${Date.now()}`;
  const adminEmail = `admin-${Date.now()}@test.com`;
  const adminPassword = 'AdminPassword123!';

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

    // 1. Onboard Tenant
    const onboardRes = await request(app.getHttpServer())
      .post('/tenants')
      .send({
        name: 'Audit Integration Tenant',
        slug: tenantSlug,
        admin_email: adminEmail,
        admin_password: adminPassword,
      })
      .expect(201);

    tenantId = onboardRes.body.tenant.id;
    adminId = onboardRes.body.admin_user.id;

    // 2. Login as Admin
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: tenantSlug,
        email: adminEmail,
        password: adminPassword,
      })
      .expect(200);

    adminToken = loginRes.body.access_token;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('POST /users: creates manager and rejects duplicate email or invalid role', async () => {
    const managerEmail = `manager-${Date.now()}@test.com`;

    // 1. Create valid manager
    const createRes = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: managerEmail,
        password: 'ManagerPassword123!',
        role: 'MANAGER',
      })
      .expect(201);

    expect(createRes.body.id).toBeDefined();
    expect(createRes.body.role).toBe('MANAGER');
    expect(createRes.body.password_hash).toBeUndefined();
    managerId = createRes.body.id;

    // Login as manager to obtain manager token
    const mLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: tenantSlug,
        email: managerEmail,
        password: 'ManagerPassword123!',
      })
      .expect(200);
    managerToken = mLogin.body.access_token;

    // 2. Duplicate email rejected with 409 Conflict
    const dupRes = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: managerEmail,
        password: 'AnotherPassword123!',
        role: 'VIEWER',
      })
      .expect(409);

    expect(dupRes.body.error_code).toBe('DUPLICATE_USER_EMAIL');

    // 3. Invalid role rejected with 400 Bad Request
    const invalidRoleRes = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `invalid-role-${Date.now()}@test.com`,
        password: 'ValidPassword123!',
        role: 'SUPERADMIN',
      })
      .expect(400);

    expect(invalidRoleRes.body.error_code).toBe('VALIDATION_ERROR');
  });

  it('GET /users & GET /users/:id: lists and retrieves users with pagination', async () => {
    const listRes = await request(app.getHttpServer())
      .get('/users?page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(listRes.body.data).toBeInstanceOf(Array);
    expect(listRes.body.total).toBeGreaterThanOrEqual(2);
    expect(listRes.body.page).toBe(1);
    expect(listRes.body.limit).toBe(10);

    // Verify password_hash is not exposed
    for (const u of listRes.body.data) {
      expect(u.password_hash).toBeUndefined();
    }

    // Retrieve single user
    const singleRes = await request(app.getHttpServer())
      .get(`/users/${managerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(singleRes.body.id).toBe(managerId);
    expect(singleRes.body.role).toBe('MANAGER');
  });

  it('PATCH /users/:id: enforces LAST_ACTIVE_ADMIN_REQUIRED and immediate deactivation', async () => {
    // 1. Attempt to demote sole admin to VIEWER -> rejected with 409 LAST_ACTIVE_ADMIN_REQUIRED
    const demoteRes = await request(app.getHttpServer())
      .patch(`/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'VIEWER' })
      .expect(409);

    expect(demoteRes.body.error_code).toBe('LAST_ACTIVE_ADMIN_REQUIRED');

    // 2. Attempt to deactivate sole admin -> rejected with 409 LAST_ACTIVE_ADMIN_REQUIRED
    const deactRes = await request(app.getHttpServer())
      .patch(`/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ is_active: false })
      .expect(409);

    expect(deactRes.body.error_code).toBe('LAST_ACTIVE_ADMIN_REQUIRED');

    // 3. Create a second admin user
    const secondAdminRes = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `second-admin-${Date.now()}@test.com`,
        password: 'AdminPassword123!',
        role: 'ADMIN',
      })
      .expect(201);

    const secondAdminId = secondAdminRes.body.id;

    // 4. Now demoting second admin succeeds because there are 2 active admins
    await request(app.getHttpServer())
      .patch(`/users/${secondAdminId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'MANAGER' })
      .expect(200);

    // 5. Deactivate manager user
    await request(app.getHttpServer())
      .patch(`/users/${managerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ is_active: false })
      .expect(200);

    // Retrieve manager email cleanly before sending login
    const mgrRes = await request(app.getHttpServer())
      .get(`/users/${managerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // 6. Deactivated manager login is rejected with 401 AUTH_UNAUTHORIZED
    const deactLoginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenant_slug: tenantSlug,
        email: mgrRes.body.email,
        password: 'ManagerPassword123!',
      })
      .expect(401);

    expect(deactLoginRes.body.error_code).toBe('AUTH_UNAUTHORIZED');

    // 7. Deactivated manager using pre-existing token is rejected with 403 TENANT_MEMBERSHIP_REQUIRED
    const deactJwtRes = await request(app.getHttpServer())
      .get('/tenants/me')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);

    expect(deactJwtRes.body.error_code).toBe('TENANT_MEMBERSHIP_REQUIRED');
  });

  it('GET /audit-logs: lists tenant audit logs and never exposes pre-auth rows', async () => {
    const auditRes = await request(app.getHttpServer())
      .get('/audit-logs?page=1&limit=20')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(auditRes.body.data).toBeInstanceOf(Array);
    expect(auditRes.body.total).toBeGreaterThanOrEqual(1);

    for (const log of auditRes.body.data) {
      expect(log.tenant_id).toBe(tenantId);
      expect(log.tenant_id).not.toBeNull();
    }
  });
});
