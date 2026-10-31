# OmniStock Phase 3 Postman Test Suite

This directory contains the automated Postman Collection and Environment for **OmniStock MVP Phase 3: Multi-Tenant Onboarding & Isolation**.

## 1. Files Included

- `OmniStock-Phase-3.postman_collection.json`: The complete collection covering 24 automated tests across 5 organized sections:
  1. **Tenant Onboarding & Auth**: `POST /tenants`, `POST /auth/login`, `GET /tenants/me`.
  2. **User Management**: `POST /users`, `POST /auth/login` (as Manager), `GET /users`, `GET /users/:id`, `PATCH /users/:id`.
  3. **Audit Logs**: `GET /audit-logs`.
  4. **Cross-Tenant Isolation**: Provisioning a second tenant, proving Tenant 1 cannot read (`GET`) or update (`PATCH`) Tenant 2 users (`404 USER_NOT_FOUND`).
  5. **Authorization & Negative Tests**:
     - No token (`401 AUTH_UNAUTHORIZED`)
     - Malformed token (`401 AUTH_UNAUTHORIZED`)
     - Insufficient permissions (`403 INSUFFICIENT_PERMISSIONS`)
     - Duplicate tenant slug (`409 DUPLICATE_TENANT_SLUG`)
     - Duplicate user email in tenant (`409 DUPLICATE_USER_EMAIL`)
     - Invalid DTO payload (`400 VALIDATION_ERROR`)
     - Last active ADMIN protection demote & deactivate (`409 LAST_ACTIVE_ADMIN_REQUIRED`)
- `OmniStock-Local.postman_environment.json`: Local execution environment configured with `baseUrl: http://localhost:3000` and dynamic token/id variables.

## 2. Prerequisites

1. PostgreSQL 16 database running via Docker:
   ```bash
   docker compose up -d
   ```
2. Migrations executed:
   ```bash
   npm run migration:run
   ```
3. NestJS Application running:
   ```bash
   npm run start
   ```

## 3. Running via Newman CLI (Automated Smoke Test)

You can execute the entire test collection headlessly via Newman without installing new local dependencies:

```bash
npx --yes newman run postman/OmniStock-Phase-3.postman_collection.json -e postman/OmniStock-Local.postman_environment.json
```

To export HTML or CLI report summaries:

```bash
npx --yes newman run postman/OmniStock-Phase-3.postman_collection.json -e postman/OmniStock-Local.postman_environment.json --reporters cli
```

## 4. Running via Postman Desktop

1. Open Postman.
2. Click **Import** and select:
   - `postman/OmniStock-Phase-3.postman_collection.json`
   - `postman/OmniStock-Local.postman_environment.json`
3. Select **OmniStock Local Environment** in the environment dropdown (top right).
4. Select the collection **OmniStock Phase 3 - Multi-Tenant Onboarding & Isolation**.
5. Click **Run Collection**, ensure all 24 requests are checked, and click **Run OmniStock Phase 3**.
6. All tests will execute sequentially with automated token chaining, dynamic timestamps, and strict assertions.

