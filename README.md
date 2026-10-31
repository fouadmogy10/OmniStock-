# OmniStock MVP — Multi-Tenant SaaS Inventory & Order Management System

OmniStock is a production-grade, multi-tenant inventory and order management system built with NestJS, PostgreSQL 16, and TypeORM. It provides strict tenant isolation via PostgreSQL Row-Level Security (RLS), explicit database-backed Role-Based Access Control (RBAC), an immutable double-entry stock movement ledger, automated priority-based split warehouse order allocation, authenticated external channel webhook synchronization with AES-256-GCM keyring management, and comprehensive operational readiness probes.

---

## Architecture & Security Highlights

### 1. Multi-Tenant Isolation with PostgreSQL RLS
- **Native Row-Level Security**: All 17 tenant-owned tables have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` enforced in the database engine.
- **Transaction-Scoped Context**: Tenant context is injected exclusively on dedicated transaction checkouts via `SET LOCAL app.current_tenant_id = '<uuid>'`. Context automatically resets on commit/rollback, preventing connection-pool leakage across requests.
- **Fail-Closed Execution**: If `app.current_tenant_id` is missing, malformed, or empty, queries return 0 rows or fail, completely preventing cross-tenant access.

### 2. Dual Database Role Model with Least Privileges
- **`omnistock_migrator`**: Owns database schemas, tables, indexes, triggers, and RLS policies. Used exclusively by TypeORM migrations and CLI administration.
- **`omnistock_app`**: Runtime application role configured with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`. Owns zero database objects and has no `CREATE` privileges on the `public` schema. Holds `SELECT, INSERT, UPDATE, DELETE` on mutable tables and `SELECT, INSERT` only on append-only tables (`UPDATE, DELETE, TRUNCATE` strictly revoked).
- **`omnistock_preauth_auditor`**: Dedicated `NOLOGIN` role owning the `record_pre_auth_audit_log` `SECURITY DEFINER` function for pre-authentication audit logging.

### 3. Core Functional Domains
- **Multi-Tenant Onboarding & RBAC (`Phase 3`)**: Atomic tenant registration, user provisioning, and 29 discrete permissions mapped across `ADMIN`, `MANAGER`, and `VIEWER` roles. Enforces `LAST_ACTIVE_ADMIN_REQUIRED` to prevent tenant lockout.
- **Catalog, Inventory & Low-Stock Alerts (`Phase 4`)**: Strict variant hierarchies, immutable `StockMovement` ledger tracking `delta` with non-negative constraints, per-warehouse low-stock threshold monitoring, and inter-warehouse stock transfers.
- **Customers & Split Order Allocation (`Phase 5`)**: Customer historical snapshots, 5-state order lifecycle (`PENDING` -> `ALLOCATED` -> `SHIPPED` / `CANCELLED`), deterministic multi-warehouse split allocation ordered by `(priority ASC, created_at ASC, id ASC)` with `(product_id ASC, warehouse_id ASC)` dead-lock prevention.
- **Authenticated Channel Sync & Retries (`Phase 6`)**: Webhook ingestion with raw-body HMAC-SHA256 signature verification, versioned AES-256-GCM encrypted credentials with AAD, 3-phase sync retry worker (`Claim TX` -> `Domain TX` -> `Failure TX`), and tenant-scoped operational dashboard (`GET /dashboard/summary`).
- **Operational Readiness & Health Probes (`Phase 7`)**: Zero-DB liveness probe (`GET /health/live`), lightweight readiness probe (`GET /health/ready`), Swagger documentation (`GET /api/docs`), two-tier rate limiting, correlation IDs (`X-Request-Id`), and graceful shutdown with in-flight drain.

---

## Getting Started

### Prerequisites
- Node.js 20+ (LTS)
- npm 10+
- PostgreSQL 16 (or Docker Compose)

### 1. Clone & Install Dependencies
```bash
npm ci
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Ensure runtime variables are configured (see `src/config/env.validation.ts` for schema requirements):
```dotenv
PORT=3000
NODE_ENV=development
DB_HOST=localhost
DB_PORT=5432
DB_NAME=omnistock
DB_USERNAME=omnistock_app
DB_PASSWORD=AppSecurePass123!
MIGRATOR_DB_USERNAME=omnistock_migrator
MIGRATOR_DB_PASSWORD=MigratorSecurePass123!
JWT_SECRET=e4b2c9a1d8f7e6b5c4a3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1
JWT_EXPIRATION=15m
WEBHOOK_SECRET_ENCRYPTION_KEY_ACTIVE=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
WEBHOOK_SECRET_ENCRYPTION_KEYS='{"v1":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
SYNC_WORKER_ENABLED=true
SYNC_WORKER_POLL_INTERVAL_MS=5000
SYNC_WORKER_BATCH_SIZE=10
SHUTDOWN_DRAIN_TIMEOUT_MS=15000
TRUSTED_PROXY_IPS=127.0.0.1,::1
```

### 3. Initialize PostgreSQL Roles & Schema
Start the PostgreSQL container:
```bash
docker compose up -d
```
Run TypeORM database migrations as `omnistock_migrator`:
```bash
npm run migration:run
```

### 4. Build & Start the Application
```bash
# Build TypeScript
npm run build

# Start production server
npm run start:prod
```
The application will listen on port 3000.
Interactive Swagger documentation is available at:
`http://localhost:3000/api/docs`

---

## Testing & Quality Gates

OmniStock enforces a deterministic 8-stage verification pipeline matching the continuous integration environment.

### 8-Stage Quality Gates

| Stage | Command | Purpose |
|-------|---------|---------|
| 1. Install | `npm ci` | Deterministic dependency tree installation |
| 2. Format | `npm run format:check` | Prettier code style verification |
| 3. Lint | `npm run lint` | ESLint static analysis |
| 4. Typecheck | `npm run typecheck` | Strict TypeScript compilation (`tsc --noEmit`) |
| 5. Unit Tests | `npm run test:unit` | Pure domain, security, and crypto unit test suites |
| 6. Integration | `npm run test:integration` | PostgreSQL-backed RLS, RBAC, inventory, and sync tests |
| 7. E2E | `npm run test:e2e` | End-to-end concurrency, isolation, and overselling guards |
| 8. Build | `npm run build` | NestJS production bundle compilation |

### Running Tests Locally
```bash
# Unit tests
npm run test:unit

# Integration tests (requires PostgreSQL running)
npm run test:integration

# End-to-end tests (including 100-order concurrent allocation test)
npm run test:e2e

# Run all test suites
npm test
```

### Automated Newman / Postman Smoke Test Suites
Executable Newman collections are available in `postman/`:
- Phase 3: `powershell -ExecutionPolicy Bypass -File scripts/run-smoke-tests.ps1`
- Phase 4: `powershell -ExecutionPolicy Bypass -File scripts/run-phase4-smoke-tests.ps1`
- Phase 5: `powershell -ExecutionPolicy Bypass -File scripts/run-phase5-smoke-tests.ps1`
- Phase 6: `powershell -ExecutionPolicy Bypass -File scripts/run-phase6-smoke-tests.ps1`
- Phase 7: `powershell -ExecutionPolicy Bypass -File scripts/run-phase7-smoke-tests.ps1`

---

## Backup, Restore & Verification (`T076`)

### 1. Logical Backup
Generate a portable archive excluding owner and privilege metadata:
```bash
pg_dump -h localhost -U omnistock_migrator -d omnistock --format=custom --no-owner --no-acl -f omnistock.dump
```
> **Security Note**: `WEBHOOK_SECRET_ENCRYPTION_KEYS` are managed in external keyring storage and are never stored in database dumps.

### 2. Target Database Bootstrap & Restore
```bash
# Initialize roles on target cluster
psql -h localhost -U postgres -d postgres -f docker/postgres/init-roles.sql

# Restore schema and data into target database
pg_restore -h localhost -U omnistock_migrator -d omnistock_restore_verify --no-owner --no-acl omnistock.dump

# Re-apply non-owner least privilege grants
npm run migration:run
```

### 3. Isolated Restore Verification
Run the automated verification script to validate RLS policies, immutability triggers, and role isolation:
```bash
psql -v ON_ERROR_STOP=1 -h localhost -U omnistock_migrator -d omnistock_restore_verify -f scripts/verify-restore.sql
```

---

## License
UNLICENSED — OmniStock Proprietary

