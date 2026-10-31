# Implementation Plan: OmniStock MVP

**Branch**: `001-omnistock-mvp` | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-omnistock-mvp/spec.md`

## Summary
Implement a comprehensive multi-tenant SaaS Inventory & Order Management System using Clean Architecture. The system features strict tenant isolation across all 17 tenant-owned tables, explicit permission-based RBAC (`PermissionsGuard` with `@RequirePermissions` evaluating database-loaded `User.role`), an immutable inventory movement ledger, customer and catalog variant management, inter-warehouse stock transfers (`IN_TRANSIT`), in-app per-warehouse-SKU low-stock alerts (`LowStockAlert` with `ON DELETE RESTRICT`), an explicit 5-state order lifecycle, automatic priority-ordered split warehouse allocation, an operational dashboard/reporting module (`period_order_value`), and a resilient idempotent synchronization foundation with HMAC-SHA256 webhook verification (`SyncWebhookCredential` & `WebhookSignatureGuard`), three-phase transaction boundaries, exponential backoff retry scheduling, lease-based crash recovery, and append-only attempt history (`SyncLog` & `SyncAttempt`).

## Technical Context

**Language/Version**: TypeScript (Node.js 20+)

**Primary Dependencies**: NestJS (Framework), TypeORM (ORM), Passport (Auth), Swagger (OpenAPI)

**Storage**: PostgreSQL (with Row-Level Security (RLS) multi-tenancy and version-controlled TypeORM migrations)

**Testing**: Jest (Unit/Integration), Supertest (E2E)

**Target Platform**: Dockerized Web Service (Cloud-agnostic)

**Project Type**: Web Service / API-First

**Performance Goals**: <500ms p95 for order allocation; 1000+ RPS for inventory lookups.

**Constraints**: Strict multi-tenant isolation; deny-by-default permission RBAC; 100% auditability for stock movements; prevent negative stock, partial reservations, and duplicate active low-stock alerts.

**Scale/Scope**: MVP for small-to-medium businesses managing up to 10 warehouses and 100k SKUs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Plan | Status |
|-----------|------|--------|
| I. Clean Architecture | Use NestJS Modules; separate Controller -> Service -> Repository -> Domain Entity. | ✅ PASS |
| II. Multi-Tenant Isolation | Extract `tenant_id` solely from authenticated server-side JWT context (or verified `SyncWebhookCredential` via `WebhookSignatureGuard`); scope DB transactions via `SET LOCAL app.current_tenant_id` and enforce PostgreSQL RLS (`ENABLE` + `FORCE ROW LEVEL SECURITY` with `NULLIF(current_setting('app.current_tenant_id', true), '')::uuid` policies) under a non-owner, `NOBYPASSRLS` runtime DB role across all 17 tenant-owned tables (`users`, `audit_logs`, `customers`, `categories`, `products`, `warehouses`, `inventory_items`, `low_stock_alerts`, `stock_movements`, `stock_transfers`, `stock_transfer_items`, `orders`, `order_items`, `order_allocations`, `sync_webhook_credentials`, `sync_logs`, `sync_attempts`). | ✅ PASS |
| III. Inventory Accuracy | `StockMovement` table is append-only, enforced authoritatively at the PostgreSQL database level (`BEFORE UPDATE OR DELETE` trigger blocking mutations + restricted role privileges) and paired with transactional repository inserts on every physical (`on_hand`) stock change (adjustments, transfer dispatches/receipts, order shipments; `RETURN` is a reserved enum value in MVP). | ✅ PASS |
| IV. Transactional Integrity | Use database-level transactions with pessimistic locking (`SELECT FOR UPDATE` in global `(product_id ASC, warehouse_id ASC)` order), all-or-nothing split `OrderAllocation` reservations, transactional `LowStockAlert` evaluation, and explicit PostgreSQL `CHECK` constraints (`on_hand >= 0`, `reserved >= 0`, `reserved <= on_hand`, `in_transit >= 0`, `low_stock_threshold IS NULL OR low_stock_threshold >= 0`); `available` is strictly derived as `on_hand - reserved`. | ✅ PASS |
| V. API-First | Swagger/OpenAPI generated from code; consistent response decorators; `contracts/api.md` as sole authoritative HTTP contract. | ✅ PASS |
| VI. Security by Design | JWT-based auth + independent tenant-membership verification + deny-by-default `PermissionsGuard` (`@RequirePermissions` evaluating database-loaded `User.role`) + `WebhookSignatureGuard` (HMAC-SHA256 with `SyncWebhookCredential`); last-admin protection (`LAST_ACTIVE_ADMIN_REQUIRED`); input validation pipes; never trust client-supplied `tenant_id`; foundational append-only `AuditLog` module (distinct from `StockMovement`) with strict tenant RLS and a narrowly scoped `SECURITY DEFINER` function for pre-auth failures. | ✅ PASS |
| VII. Automated Testing | Mandatory automated tests for core business logic (split allocation, reservation rollback, order state transitions, stock transfers, low-stock alerts, dashboard reporting, sync 3-phase retry/lease recovery/idempotency, webhook HMAC verification, explicit RBAC permissions, user/audit/product/warehouse validation, RLS unset/empty/malformed context, pool isolation, DB role non-ownership, DB constraints, ledger/audit immutability, migrations). | ✅ PASS |
| VIII. Idempotent Sync | `SyncWebhookCredential`, `SyncLog` (logical event + lease & retry state machine with per-tenant RLS-safe `SELECT ... FOR UPDATE SKIP LOCKED` worker claiming across 3 isolated transaction phases), and append-only `SyncAttempt` (attempt execution history) to ensure idempotency, exponential backoff retries, crash lease recovery, and failure tracking for channel sync. | ✅ PASS |
| IX. Maintainability | Follow SOLID; strictly typed interfaces; comprehensive READMEs. | ✅ PASS |
| X. Scalability | Indexing on `tenant_id`, `sku`, `barcode`, `priority`, `next_retry_at`, `lease_expires_at`, and `low_stock_alerts`; pagination for all list endpoints; version-controlled TypeORM migrations (`synchronize: false`). | ✅ PASS |

## Foundational Database & Security Architecture

### 1. PostgreSQL RLS & Transaction-Scoped Tenant Context
- **Enforcement Mechanism**: Every tenant-owned table (`users`, `audit_logs`, `customers`, `categories`, `products`, `warehouses`, `inventory_items`, `low_stock_alerts`, `stock_movements`, `stock_transfers`, `stock_transfer_items`, `orders`, `order_items`, `order_allocations`, `sync_webhook_credentials`, `sync_logs`, `sync_attempts`) enforces PostgreSQL Row-Level Security via `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` and `ALTER TABLE ... FORCE ROW LEVEL SECURITY;` with the tenant isolation policy applied to the runtime role (`omnistock_app`):
  ```sql
  CREATE POLICY <table>_tenant_isolation ON <table>
    FOR ALL TO omnistock_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
  ```
- **Context Evaluation Semantics**:
  - **Unset setting**: `current_setting('app.current_tenant_id', true)` returns `NULL`, so `NULLIF(..., '')::uuid` evaluates to `NULL` (0 rows matched on reads; writes rejected by `WITH CHECK`).
  - **Empty setting (`''`)**: `NULLIF('', '')::uuid` evaluates to `NULL` (0 rows matched on reads; writes rejected by `WITH CHECK`).
  - **Valid UUID**: Enforces strict `tenant_id` equality on both `USING` and `WITH CHECK`.
  - **Malformed UUID**: Fails closed with a PostgreSQL UUID cast error (`22P02 invalid_text_representation`); never grants access or broadens visibility.
- **Transaction-Scoped Context (`SET LOCAL`) & Worker RLS Compatibility (`F7-6`)**:
  - For authenticated user HTTP requests, `TenantInterceptor` derives `tenant_id` exclusively from the verified server-side JWT payload (never from client headers, query params, or body payloads), executes `SET LOCAL app.current_tenant_id = '<tenant_uuid>'` inside the active database transaction, and loads the current active `User` row (`is_active = true`) from `users` for `PermissionsGuard`.
  - For inbound webhook requests (`POST /sync/webhook/{source}`), `WebhookSignatureGuard` resolves `tenant_id` from the global non-RLS `tenants` table (`WHERE slug = :slug AND is_active = true`), opens a transaction with `SET LOCAL app.current_tenant_id = '<tenant_id>'`, and verifies the HMAC-SHA256 signature against `sync_webhook_credentials` under standard tenant RLS.
  - For internal background retry workers (`SyncRetryWorker` running as `SYSTEM_WORKER` over the standard `omnistock_app` DB role without `BYPASSRLS`), the worker **never queries `sync_logs` globally before tenant context is set**: it first reads active `tenant_id` values from the global non-RLS `tenants` table (`SELECT id FROM tenants WHERE is_active = true ORDER BY id ASC`), and then for each tenant opens separate Phase A (claim/lease recovery), Phase B (domain execution), and Phase C (failure persistence) transactions, executing `SET LOCAL app.current_tenant_id = '<tenant_id>'` at the start of every transaction before touching `sync_logs`, `sync_attempts`, or any other tenant-owned table.
- **Connection Pool Safety**: Session-level `SET` MUST NOT be used because pooled connections are reused across requests and would leak tenant context to subsequent callers. `SET LOCAL` automatically resets when the transaction commits or rolls back.
- **Database Role Separation & Ownership**:
  1. **Migration / Admin Role (`omnistock_migrator`)**: Owns application schemas, tables, sequences, and migration objects; executes version-controlled DDL migrations (`up`/`down`); is never used by normal application runtime requests.
  2. **Runtime Application Role (`omnistock_app`)**: Must not own any tenant tables or schemas; created with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`; possesses zero DDL, table-ownership, trigger-modification, or RLS policy-modification privileges; receives only required DML privileges (`SELECT, INSERT, UPDATE, DELETE` on mutable tenant tables, `SELECT, INSERT, UPDATE` on `tenants` for onboarding/directory lookup, and `SELECT, INSERT` only with `UPDATE, DELETE, TRUNCATE` revoked on append-only `stock_movements`, `audit_logs`, and `sync_attempts`).

### 2. Database-Level Inventory Constraints, Immutable Ledgers & Foundational AuditLog
- **Inventory & Low-Stock Alert Invariants (`F2-1`)**: `InventoryItem` enforces `CHECK (on_hand >= 0)`, `CHECK (reserved >= 0)`, `CHECK (reserved <= on_hand)`, `CHECK (in_transit >= 0)`, and `CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0)` at the PostgreSQL layer. `available` is strictly derived (`on_hand - reserved`) and never independently writable; `in_transit` is never counted in `on_hand` or `available`. `LowStockAlert` enforces `UNIQUE (tenant_id, inventory_item_id) WHERE status = 'OPEN'` to guarantee at most one active alert per warehouse SKU, and its composite foreign key to `inventory_items` enforces `ON DELETE RESTRICT` (matching `Product` and `Warehouse` `ON DELETE RESTRICT`) so historical resolved alerts can never be cascade-deleted.
- **Authoritative `StockMovement` & `SyncAttempt` Immutability**: `StockMovement` (`prevent_stock_movement_mutation()`) and `SyncAttempt` (`prevent_sync_attempt_mutation()`) are protected at the PostgreSQL layer by `BEFORE UPDATE OR DELETE` triggers that unconditionally raise an exception, reinforced by granting only `SELECT, INSERT` to `omnistock_app` (`UPDATE, DELETE, TRUNCATE` revoked).
- **Foundational `AuditLog` Isolation, Pre-Auth Events & Immutability**:
  - `AuditLog` is a Phase 2 foundational entity/service (`src/modules/audit/`) kept strictly separate from `StockMovement`.
  - **Tenant-Scoped Requests**: Under `audit_logs_tenant_isolation`, `omnistock_app` may insert and read `AuditLog` rows only when `tenant_id` matches `NULLIF(current_setting('app.current_tenant_id', true), '')::uuid`, and can never read or directly insert `tenant_id IS NULL` rows.
  - **Unattributable Pre-Authentication Events (`tenant_id IS NULL`)**: Recorded exclusively via a narrowly scoped PostgreSQL `SECURITY DEFINER` function `record_pre_auth_audit_log(p_action text, p_metadata jsonb)` owned by a dedicated `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` role (`omnistock_preauth_auditor`) with a fixed `SET search_path = pg_catalog, public`, granted `INSERT` only on `audit_logs` under a dedicated `FOR INSERT TO omnistock_preauth_auditor WITH CHECK (tenant_id IS NULL AND actor_user_id IS NULL AND entity_type = 'Auth' AND action IN ('AUTH_LOGIN_FAILURE', 'AUTH_TOKEN_INVALID', 'SYNC_WEBHOOK_AUTH_FAILURE'))` policy, and `EXECUTE` granted only to `omnistock_app` for internal server-side auth failure handling (never exposed via a public generic endpoint).
  - **Append-Only `AuditLog` Enforcement**: Protected at the database level by a `BEFORE UPDATE OR DELETE` trigger (`prevent_audit_log_mutation()`) and by revoking `UPDATE, DELETE, TRUNCATE` from `omnistock_app` and `omnistock_preauth_auditor`.
- **Version-Controlled Migrations**: All schema definitions, roles, RLS policies, `CHECK` constraints, and database triggers are managed through explicit SQL TypeORM migrations with documented rollback (`down`) routines (`synchronize: false`).

### 3. Operational Readiness, Observability, Test Infrastructure, Backup/Restore & CI Quality Gates (Batch 4)
- **Runtime vs. Migration Environment Separation & Effective Privilege Verification (`FR-019`)**:
  - The runtime application (`DatabaseModule`) loads only `DB_APP_USER` / `DB_APP_PASSWORD` (`omnistock_app`) and never loads `DB_MIGRATOR_USER` / `DB_MIGRATOR_PASSWORD` (which are restricted to the migration CLI `src/common/database/data-source.ts` and isolated `*_test` database provisioning).
  - `JWT_SECRET` is validated at startup to contain at least **32 UTF-8 bytes (`Buffer.byteLength(JWT_SECRET, 'utf8') >= 32`)** (after rejecting empty/whitespace-only and single-character-repeated strings). `>= 32` UTF-8 bytes is explicitly a **byte-length requirement only** (not proof of cryptographic entropy), and a non-repeating-character check is a basic sanity check only and never an entropy guarantee; production `JWT_SECRET` values MUST be generated using a CSPRNG with at least 32 random bytes, and production startup (`NODE_ENV === 'production'`) fails closed on any missing, weak, known-placeholder, or invalid secret (while development/test environments may use environment-specific secrets satisfying the documented validation rules).
  - On startup (`DatabaseModule.onModuleInit()`), the runtime connection executes a fail-closed PostgreSQL catalog and effective-privilege inspection using `pg_roles`, `pg_auth_members`, `pg_class`, `pg_namespace`, `pg_has_role()`, `has_table_privilege()`, and `has_schema_privilege()` to verify that `current_user` (including any inherited role memberships):
    1. Has `rolsuper = false`, `rolbypassrls = false`, `rolcreatedb = false`, and `rolcreaterole = false`;
    2. Is not a direct or transitive member of `omnistock_migrator`, `omnistock_preauth_auditor`, `pg_read_all_data`, or `pg_write_all_data` (`pg_has_role(..., 'MEMBER') = false`);
    3. Does not own the `public` schema or any of the 18 application tables (`tenants` + 17 tenant-owned tables) and has `has_schema_privilege(current_user, 'public', 'CREATE') = false`;
    4. Has effective `UPDATE = false`, `DELETE = false`, `TRUNCATE = false`, `TRIGGER = false`, and `REFERENCES = false` on `stock_movements`, `audit_logs`, and `sync_attempts`, plus `TRUNCATE = false` and `TRIGGER = false` across all 18 tables; and
    5. Sees `relrowsecurity = true` and `relforcerowsecurity = true` on all 17 tenant-owned tables.
- **API Conventions & Two-Tier Webhook Rate Limiting (`FR-020`)**:
  - `ApiExceptionFilter` enforces a canonical JSON error envelope (`statusCode`, `error_code`, `message`, optional `details`, `request_id`, `timestamp`) and suppresses internal stack traces on `500 INTERNAL_SERVER_ERROR`.
  - All 10 paginated `GET` list endpoints enforce `page` (`>= 1`, default `1`), `limit` (`1..100`, default `20`), and return `{ data, page, limit, total }`.
  - Global `ValidationPipe` enforces `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true` (rejecting unknown fields and client-supplied `tenant_id` in request bodies with `400 VALIDATION_ERROR`).
  - Rate limiting (`429 RATE_LIMIT_EXCEEDED` with `Retry-After`) resolves `client_ip` using a strict trusted-proxy policy — never trusting arbitrary client-supplied `X-Forwarded-For` headers, honoring `X-Forwarded-For` via right-to-left non-trusted hop selection **only** when the immediate socket peer (`req.socket.remoteAddress`) is in explicitly configured `TRUSTED_PROXY_IPS` (default empty/disabled), and otherwise using `req.socket.remoteAddress` directly — and applies this `client_ip` consistently across `POST /tenants` (by `client_ip`), `POST /auth/login` (by `client_ip + tenant_slug + email` plus coarse `client_ip` ceiling), and `POST /sync/webhook/{source}` via a **two-tier architecture**:
    1. **Pre-Authentication Tier (before `WebhookSignatureGuard`)**: Enforces IP (`webhook:preauth:ip:${client_ip}`) and source+IP (`webhook:preauth:source_ip:${lower(source)}:${client_ip}`) limits using the trusted `client_ip` policy without ever trusting the unverified `X-Sync-Tenant-Slug` header as a tenant bucket key.
    2. **Post-HMAC Verification Tier (inside/after `WebhookSignatureGuard`)**: Enforces the tenant-specific rate limit keyed strictly by the verified `tenant_id` and normalized `source` (`webhook:tenant:${verified_tenant_id}:${lower(source)}`).
- **Observability, Correlation IDs, Health Probes & Graceful Shutdown (`FR-021`, `FR-022`)**:
  - `X-Request-Id` is validated (`^[A-Za-z0-9._-]{1,64}$`) or generated (UUIDv4), echoed on responses, and bound to structured JSON logs. Log context populates `tenant_id` and `user_id` exclusively from authenticated/verified server-side context, and redacts passwords, hashes, JWTs, `Authorization` headers, `webhook_secret`, `encrypted_secret`, `secret_hash`, encryption keys, and `X-Sync-Signature`.
  - `GET /health/live` (zero DB dependency) and `GET /health/ready` (`SELECT 1` over `omnistock_app` without querying tenant tables or setting tenant context; returns `503 not_ready` during shutdown/failure) provide infrastructure probes without leaking internal details.
  - Graceful shutdown (`app.enableShutdownHooks()` for `SIGTERM`/`SIGINT`) tracks in-flight HTTP requests (`ShutdownDrainInterceptor`) and tracks each complete `SyncLog` processing job as a **single continuous logical unit** across all phases (`Phase A.1 Ingestion TX` when applicable, `Phase A.2 Claim TX`, `Phase B Domain TX`, and `Phase C Failure TX` when `Phase B` fails — **never** releasing the tracker at intermediate transaction boundaries between `Phase A`, `Phase B`, and `Phase C`), immediately flips readiness to `not_ready`, stops accepting new worker jobs/claims, awaits currently tracked multi-phase jobs (including `Phase C` failure persistence when `Phase B` fails) up to `SHUTDOWN_DRAIN_TIMEOUT_MS` without silently treating timed-out jobs as completed, and closes the TypeORM `DataSource` pool only after the drain procedure finishes.
- **Database Test Isolation, Backup/Restore & Deterministic 8-Stage CI (`FR-023`)**:
  - Runtime/HTTP/service test assertions run strictly as `omnistock_app` (`NOBYPASSRLS`) with fresh per-test/per-suite tenants; `omnistock_migrator` is never used for assertions and `omnistock_app` is never granted extra privileges. Automatic `SyncRetryWorker` timer polling is disabled in HTTP integration tests (`SYNC_WORKER_ENABLED=false`) in favor of deterministic manual `runTick()` invocations.
  - Backup and restore procedures separate cluster role bootstrap (`omnistock_migrator`, `omnistock_app`, `omnistock_preauth_auditor`) and ownership/ACL application (`T039`) from `pg_dump --format=custom --no-owner --no-acl`, preserve external `WEBHOOK_SECRET_ENCRYPTION_KEYS` versions outside database backups, and verify RLS, append-only triggers, effective privileges, and keyring compatibility in an isolated restore database before routing traffic.
  - CI enforces an 8-stage quality gate: `1. npm ci` -> `2. format:check` -> `3. lint` -> `4. typecheck` -> `5. test:unit` -> `6. PostgreSQL-backed test:integration` -> `7. test:e2e` -> `8. build`.

## Project Structure

### Documentation (this feature)

```text
specs/001-omnistock-mvp/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (api.md)
└── tasks.md             # Phase 2 output (generated by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── app.module.ts
├── config/             # Fail-closed startup env validation (runtime omnistock_app separation, >=32-byte JWT secret, keyring)
├── common/             # Interceptors (TenantInterceptor, ShutdownDrainInterceptor), Filters, Guards (JwtAuthGuard, PermissionsGuard, WebhookSignatureGuard, RateLimitGuard), Logging, Database Migrations & Effective-Privilege Verification
├── modules/
│   ├── health/         # Liveness (/health/live) and Readiness (/health/ready) probes
│   ├── tenant/         # Tenant onboarding and profile logic
│   ├── auth/           # JWT, User administration, last-admin guard, and explicit Permission RBAC
│   ├── customers/      # Tenant-scoped Customer records
│   ├── products/       # Categories, Products, Variants, SKUs, Barcodes
│   ├── warehouses/     # Priority-ordered Locations & deactivation commitment checks
│   ├── inventory/      # InventoryItems, LowStockAlerts, StockMovements, StockTransfers
│   ├── orders/         # Order State Machine, OrderItems, OrderAllocations
│   ├── dashboard/      # Tenant-scoped operational KPIs and basic reporting
│   ├── audit/          # Foundational security & activity logging
│   └── sync/           # SyncWebhookCredential, SyncLog, SyncAttempt, 3-phase retry worker, and webhook/credential controllers
└── main.ts

tests/
├── helpers/            # Multi-tenant fixtures, HMAC webhook signer, concurrency barrier, isolated *_test DB bootstrap
├── e2e/                # System-wide flows
├── integration/        # Module/DB boundaries
└── unit/               # Business logic
```

**Structure Decision**: Modular Monolith (Option 1) using NestJS Modules. This provides clear boundaries (Clean Architecture) while maintaining simplicity for the MVP. Each module encapsulates its own domain, entities, controllers, and services.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*(No violations identified)*
