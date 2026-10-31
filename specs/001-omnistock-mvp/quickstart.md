# Quickstart Validation: OmniStock MVP

Follow these steps to validate the MVP features end-to-end.

## Prerequisites
1. Database (PostgreSQL 16) is initialized with the cluster roles (`docker/postgres/init-roles.sql` creating `omnistock_migrator`, `omnistock_app` with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, and `omnistock_preauth_auditor` with `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`) and the schema, RLS policies, and constraints defined in `data-model.md` (`npm run migration:run` executed via `omnistock_migrator`).
2. Environment variables are configured and validated at startup (`FR-019`):
   - **Runtime Application Variables (`omnistock_app` only — never loads migrator credentials)**:
     - `NODE_ENV`: `development` | `test` | `production`
     - `PORT`: `3000` (default)
     - `LOG_LEVEL`: `info` | `debug` | `warn` | `error`
     - `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_APP_USER` (`omnistock_app`), `DB_APP_PASSWORD`, `DB_POOL_MAX` (default `20`)
     - `JWT_SECRET`: Minimum **32 UTF-8 bytes (`Buffer.byteLength(JWT_SECRET, 'utf8') >= 32`)** (non-empty/non-whitespace, not a repeated single character). `>= 32` UTF-8 bytes is a **length requirement only** (not proof of cryptographic entropy), and a non-repeating-character check is a basic sanity check only (never an entropy guarantee); in `production` (`NODE_ENV === 'production'`), `JWT_SECRET` MUST be generated using a CSPRNG with at least 32 random bytes, and startup fails closed on any missing, weak, known-placeholder, or invalid secret (while development and test environments may use environment-specific secrets satisfying the documented validation rules)
     - `JWT_EXPIRES_IN`: e.g., `1h`
     - `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION`: positive integer `>= 1`
     - `WEBHOOK_SECRET_ENCRYPTION_KEYS`: `<version>:<64-lowercase-hex-chars>,...` (every `hexKey` validated against `/^[0-9a-f]{64}$/` before `Buffer.from(hexKey, 'hex')` into 32 bytes)
     - `SYNC_WORKER_ENABLED`: `true` (`false` in HTTP integration tests so tests invoke `runTick()` deterministically), `SYNC_WORKER_POLL_INTERVAL_MS` (`5000`), `SYNC_WORKER_BATCH_SIZE` (`10`), `SHUTDOWN_DRAIN_TIMEOUT_MS` (`15000`)
     - `TRUSTED_PROXY_IPS`: optional comma-separated trusted proxy IPs/CIDRs (default empty/disabled so `X-Forwarded-For` is ignored unless the immediate socket peer `req.socket.remoteAddress` is a configured trusted proxy), `RATE_LIMIT_TTL_SECONDS` (`60`), `RATE_LIMIT_TENANT_ONBOARD_MAX` (`5`), `RATE_LIMIT_LOGIN_MAX` (`10`), `RATE_LIMIT_LOGIN_IP_MAX` (`30`), `RATE_LIMIT_WEBHOOK_IP_MAX` (`60`), `RATE_LIMIT_WEBHOOK_SOURCE_IP_MAX` (`120`), `RATE_LIMIT_WEBHOOK_TENANT_MAX` (`120`)
   - **Migration CLI & Test Provisioning Only (never loaded by runtime `DatabaseModule`)**:
     - `DB_MIGRATOR_USER` (`omnistock_migrator`), `DB_MIGRATOR_PASSWORD`
3. Application is running (having passed startup effective PostgreSQL privilege verification `has_table_privilege()`, `has_schema_privilege()`, and `pg_has_role()`) and a Tenant + User (`ADMIN` or `MANAGER`) have been created via `POST /tenants` and authenticated via `POST /auth/login`.
4. Obtain a JWT token for the `ADMIN` user (and optionally a `VIEWER` user created via `POST /users` to verify explicit RBAC permissions).

## Scenario 1: Catalog, Inventory Traceability, Low-Stock Alerts & Inter-Warehouse Stock Transfers
**Goal**: Verify that categories, variant SKUs, stock adjustments, per-warehouse-SKU low-stock alerts (`LowStockAlert`), and inter-warehouse transfers maintain `on_hand`, `reserved`, `in_transit`, `available = on_hand - reserved`, and immutable `StockMovement` ledger entries.

1. **Create Category & Product**:
   - `POST /categories` with `{ "name": "Footwear" }` -> returns `category_id`.
   - `POST /products` with `{ "name": "Running Shoe - Red / 42", "category_id": "<category_id>", "sku": "SHOE-RED-42", "barcode": "6281000000012", "price": 250.00 }` -> returns `product_id`.
2. **Create Two Priority-Ordered Warehouses**:
   - `POST /warehouses` with `{ "name": "Riyadh Hub", "location": "Riyadh", "priority": 1 }` -> returns `warehouse_a_id`.
   - `POST /warehouses` with `{ "name": "Jeddah Hub", "location": "Jeddah", "priority": 2 }` -> returns `warehouse_b_id`.
3. **Adjust Stock & Configure Low-Stock Threshold**:
   - `POST /inventory/adjust` with `{ "product_id": "<product_id>", "warehouse_id": "<warehouse_a_id>", "delta": 50, "reason": "Initial receiving" }` -> returns `inventory_item_a_id`.
   - `PATCH /inventory/items/{inventory_item_a_id}/threshold` with `{ "low_stock_threshold": 35 }` -> sets threshold to `35` on Warehouse A (`available: 50 > 35`, so 0 open alerts).
4. **Verify Levels & Ledger**:
   - `GET /inventory/levels?product_id=<product_id>` -> Warehouse A shows `on_hand: 50, reserved: 0, in_transit: 0, available: 50, low_stock_threshold: 35`.
   - `GET /inventory/movements?product_id=<product_id>` -> Verify one record exists with `delta: 50` and `type: 'ADJUSTMENT'`.
5. **Dispatch & Receive Inter-Warehouse Transfer (Triggering Low-Stock Alert)**:
   - `POST /transfers` with `{ "source_warehouse_id": "<warehouse_a_id>", "destination_warehouse_id": "<warehouse_b_id>", "items": [{ "product_id": "<product_id>", "quantity": 20 }] }` -> returns `transfer_id` in status `DRAFT`.
   - `POST /transfers/{transfer_id}/dispatch` -> status transitions to `IN_TRANSIT`.
   - `GET /inventory/levels?product_id=<product_id>` -> Verify Warehouse A has `on_hand: 30, available: 30` (`<= low_stock_threshold: 35`) and Warehouse B has `on_hand: 0, in_transit: 20, available: 0` (`in_transit` is never counted as `available` in either warehouse).
   - `GET /alerts/low-stock?status=OPEN` -> Verify exactly one `OPEN` `LowStockAlert` exists for `inventory_item_a_id` with `threshold: 35, current_available: 30`.
   - Attempt `PATCH /warehouses/{warehouse_b_id}` with `{ "is_active": false }` while `in_transit == 20` -> Verify `409 Conflict` (`WAREHOUSE_HAS_ACTIVE_STOCK_COMMITMENTS`).
   - `POST /transfers/{transfer_id}/receive` -> status transitions to `RECEIVED` (full dispatched quantity received).
   - `GET /inventory/levels?product_id=<product_id>` -> Verify Warehouse B now has `on_hand: 20, in_transit: 0, available: 20`, and `GET /inventory/movements` contains both outbound (`-20`) and inbound (`+20`) `TRANSFER` records referencing `transfer_id`.
   - Replenish Warehouse A via `POST /inventory/adjust` (`delta: +10`, bringing `available` to `40 > 35`) and verify `GET /alerts/low-stock?status=RESOLVED` shows the alert transitioned automatically to `RESOLVED` with non-null `resolved_at` and is permanently preserved (`ON DELETE RESTRICT`).

## Scenario 2: Customer Management, Priority Split Allocation, Shipment & Insufficient-Stock Rejection
**Goal**: Verify that orders link to `Customer` with historical snapshots, allocate deterministically across multiple warehouses via `OrderAllocation`, reject insufficient stock all-or-nothing, and convert reservations into `SALE` ledger movements upon shipment.

1. **Setup Customer & Stock**:
   - `POST /customers` with `{ "name": "Ahmed Al-Harbi", "email": "ahmed@example.com", "phone": "+966500000001" }` -> returns `customer_id`.
   - Set SKU `SHOE-RED-42` stock so Warehouse A (`priority: 1`) has `on_hand: 5, reserved: 0, available: 5` and Warehouse B (`priority: 2`) has `on_hand: 10, reserved: 0, available: 10` (total `available = 15`).
2. **Create Order Requiring Split Allocation**:
   - `POST /orders` with `{ "customer_id": "<customer_id>", "auto_allocate": true, "items": [{ "product_id": "<product_id>", "quantity": 12 }] }`.
   - Verify `201 Created` with `status: "ALLOCATED"`, `customer_name_snapshot: "Ahmed Al-Harbi"`, and `customer_email_snapshot: "ahmed@example.com"`.
3. **Verify Split `OrderAllocation` & Reservations**:
   - `GET /orders/{order_id}` -> Verify `items[0].allocations` contains two records:
     - `{ "warehouse_id": "<warehouse_a_id>", "allocated_quantity": 5 }`
     - `{ "warehouse_id": "<warehouse_b_id>", "allocated_quantity": 7 }`
   - `GET /inventory/levels?product_id=<product_id>` -> Verify Warehouse A has `on_hand: 5, reserved: 5, available: 0` and Warehouse B has `on_hand: 10, reserved: 7, available: 3`.
4. **Verify All-or-Nothing Insufficient-Stock Rejection**:
   - Attempt `POST /orders` with `{ "customer_id": "<customer_id>", "auto_allocate": true, "items": [{ "product_id": "<product_id>", "quantity": 5 }] }` (exceeding the `3` remaining available units).
   - Verify `409 Conflict` (`INSUFFICIENT_STOCK`), no new `ALLOCATED` or `PENDING` order created, and Warehouse B still has `reserved: 7, available: 3` (zero partial reservations left behind).
5. **Ship Allocated Order & Verify Cancellation Guard**:
   - `POST /orders/{order_id}/ship` -> Verify `status: "SHIPPED"`.
   - `GET /inventory/levels?product_id=<product_id>` -> Verify Warehouse A has `on_hand: 0, reserved: 0, available: 0` and Warehouse B has `on_hand: 3, reserved: 0, available: 3`.
   - `GET /inventory/movements?reference_id=<order_id>` -> Verify two `SALE` records (`delta: -5` at Warehouse A and `delta: -7` at Warehouse B) referencing `order_id`.
   - Attempt `POST /orders/{order_id}/cancel` -> Verify `409 Conflict` (`INVALID_ORDER_TRANSITION`).

## Scenario 3: Multi-Tenant Isolation, Explicit RBAC Permissions & Operational Dashboard
**Goal**: Verify that Tenant B cannot see or mutate Tenant A's data across any tenant-owned resource, that `PermissionsGuard` enforces DB-backed `User.role` and last-active-`ADMIN` protection, and that `GET /dashboard/summary` returns accurate tenant-scoped metrics.

1. **Setup**: Create `Product X`, `Customer X`, and `Order X` in Tenant A.
2. **Verify Explicit RBAC & Last-Active-Admin Guard (`F10-2`, `F10-3`)**:
   - As the sole active `ADMIN` in Tenant A, attempt `PATCH /users/{admin_user_id}` with `{ "role": "MANAGER" }` or `{ "is_active": false }` -> Returns `409 Conflict` (`LAST_ACTIVE_ADMIN_REQUIRED`).
   - Authenticate as a `VIEWER` user in Tenant A.
   - Call `GET /dashboard/summary?from=2026-10-01T00:00:00.000Z&to=2026-10-30T23:59:59.999Z` -> Returns `200 OK` (`dashboard:read` granted to `VIEWER`) with accurate `catalog_and_network`, `orders_by_status`, `period_order_value` (`allocated_order_value`, `shipped_order_value`, `combined_committed_order_value` — gross order values only), `inventory_quantity_summary` (active products in active warehouses only, excluding inventory cost valuation), `low_stock_alerts_count` (open alerts on active products in active warehouses only), and period-filtered `recent_orders` and `recent_stock_movements`.
   - Call `GET /dashboard/summary?from=2026-10-01` (date-only string without explicit UTC offset) -> Returns `400 Bad Request` (`VALIDATION_ERROR`).
   - Attempt `POST /products` or `GET /sync/logs` as `VIEWER` -> Returns `403 Forbidden` (`INSUFFICIENT_PERMISSIONS`).
3. **Test Cross-Tenant Isolation**:
   - Login as User from Tenant B.
   - `GET /products` -> `Product X` MUST NOT be in the response.
   - `GET /customers` -> `Customer X` MUST NOT be in the response.
   - `GET /products/{id_of_product_x}`, `GET /customers/{id_of_customer_x}`, and `GET /orders/{id_of_order_x}` -> MUST return `404 Not Found` or `403 Forbidden`.

## Scenario 4: Authenticated Webhook Sync, 3-Phase Attempt Tracking & Manual Retry Acceleration (`F7-1`..`F7-6`, `F10-1`, `F7-CRYPTO-1`..`F7-CRYPTO-3`, `A9`)
**Goal**: Verify that inbound webhooks require a valid `SyncWebhookCredential` HMAC-SHA256 signature computed over the exact raw request body (`req.rawBody`), duplicate webhooks are idempotent, transient retryable failures schedule retries in `RETRY_SCHEDULED` and can be accelerated via `POST /sync/logs/{id}/retry`, and permanent business failures (`FAILED_PERMANENT`) reject manual retry.

1. **Provision Channel Webhook Credential**:
   - Configure the versioned keyring environment variables `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION=1` and `WEBHOOK_SECRET_ENCRYPTION_KEYS="1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"` (each `hexKey` is validated against `/^[0-9a-f]{64}$/` before `Buffer.from(hexKey, 'hex')` into a 32-byte `Buffer` at startup).
   - As `ADMIN`, call `POST /sync/credentials` with `{ "source": "salla" }` -> Returns `201 Created` with the one-time 64-character lowercase hexadecimal `webhook_secret` (`^[0-9a-f]{64}$`). At rest, PostgreSQL stores `secret_hash = SHA-256(UTF8(webhook_secret))` (fingerprint only) and the 128-character lowercase hex `encrypted_secret` obtained by AES-256-GCM encrypting the **64 UTF-8 bytes** `Buffer.from(webhook_secret, 'utf8')` under `encryption_key_version = 1`, a fresh 12-byte CSPRNG nonce `encryption_iv` (`UNIQUE (encryption_key_version, encryption_iv)`), `encryption_auth_tag`, and `AAD = UTF8("${tenant_id}:${lower(source)}:${encryption_key_version}")` (`GET /sync/credentials` never exposes `webhook_secret`, `secret_hash`, `encrypted_secret`, `encryption_iv`, or `encryption_auth_tag`).
2. **First Signed Webhook (Success)**:
   - Construct the exact raw JSON body `Buffer` `rawBodyBuf` (`req.rawBody` on the server) and current UNIX epoch seconds `timestamp`, then compute `X-Sync-Signature: v1=<64-lowercase-hex-chars>` using the UTF-8 bytes of the 64-character hex `webhook_secret` string (`Buffer.from(webhook_secret, 'utf8')`) directly as the HMAC-SHA256 key (`createHmac('sha256', Buffer.from(webhook_secret, 'utf8')).update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBodyBuf])).digest('hex')` — never hex-decoding `webhook_secret`, never using `secret_hash`, and never applying SHA-256 key derivation). Send `POST /sync/webhook/salla` with `X-Sync-Tenant-Slug: <tenant_slug>`, `X-Sync-External-Id: ORD-123`, `X-Sync-Timestamp: <timestamp>`, `X-Sync-Signature: v1=<hex_digest>`, and valid customer/item payload (`quantity: 2` where `available >= 2`).
   - -> `WebhookSignatureGuard` verifies `^v1=[0-9a-f]{64}$`, decrypts `encrypted_secret` in memory via key version `1` and `AAD = UTF8("${tenant_id}:salla:1")`, verifies `providedSigBuf.byteLength === expectedSigBuf.byteLength === 32` before `crypto.timingSafeEqual` over `req.rawBody`, and returns `201 Created` (`SyncLog.status = "SUCCEEDED"`, `attempt_count = 1`, `order_id` populated, and `attempts[0]` with `attempt_number: 1`, `trigger_source: "WEBHOOK"`, `status: "SUCCEEDED"`).
3. **Duplicate Webhook (Idempotent Replay)**:
   - Repeat the signed request with `X-Sync-External-Id: ORD-123`.
   - -> Returns `200 OK` with the existing `SyncLog` (no duplicate order, reservation, or `SyncAttempt` created; `attempt_count` remains `1`).
4. **Transient Retryable Failure & Manual Retry Acceleration**:
   - Send a signed `POST /sync/webhook/salla` with `X-Sync-External-Id: ORD-124` while a simulated lock timeout (`55P03`) is active on the target `InventoryItem`.
   - -> Phase B rolls back completely, and Phase C commits `SyncLog` in `status: "RETRY_SCHEDULED"` (`attempt_count: 1`, `last_pg_sqlstate: "55P03"`, `last_error_code: "DB_LOCK_TIMEOUT"`, `next_trigger_source: "AUTO_RETRY"`) with `attempts[0]` (`attempt_number: 1`, `status: "FAILED_RETRYABLE"`), returning `202 Accepted`.
   - Release the lock and call `POST /sync/logs/{sync_log_id}/retry` -> Returns `202 Accepted` with `SyncLog.status = "RETRY_SCHEDULED"`, `attempt_count = 1` (not incremented in the HTTP request), `next_retry_at` set to `now()`, and `next_trigger_source = "MANUAL_RETRY"`.
   - Allow `SyncRetryWorker` to run its next poll cycle -> Phase A claims the row (`attempt_count` increments to `2`, `active_trigger_source = "MANUAL_RETRY"`) and Phase B completes order creation and allocation, transitioning `SyncLog` to `status: "SUCCEEDED"` (`attempt_count: 2`, `order_id` populated) with `attempts[1]` (`attempt_number: 2`, `trigger_source: "MANUAL_RETRY"`, `status: "SUCCEEDED"`).
5. **Permanent Business Failure Rejects Manual Retry**:
   - Send a signed `POST /sync/webhook/salla` with `X-Sync-External-Id: ORD-125` requesting `quantity: 1000` (exceeding available stock).
   - -> Returns `409 Conflict` (`INSUFFICIENT_STOCK`); `GET /sync/logs/{sync_log_id}` shows `status: "FAILED_PERMANENT"`, `attempt_count: 1`, `last_pg_sqlstate: null`, `last_http_status: null`, `last_error_code: "INSUFFICIENT_STOCK"`.
   - Attempt `POST /sync/logs/{sync_log_id}/retry` -> Returns `409 Conflict` (`INVALID_SYNC_RETRY_STATE`) because `FAILED_PERMANENT` events cannot be manually retried in MVP.

## Scenario 5: Operational Readiness, Health Probes, Two-Tier Rate Limiting, Backup/Restore & CI Quality Gates (`FR-019`..`FR-023`)
**Goal**: Verify liveness/readiness probes, correlation IDs, two-tier webhook rate limiting, graceful shutdown drain, isolated backup/restore with separate role bootstrap and external keyring retention, and the 8-stage CI quality gate pipeline.

1. **Verify Health, Readiness & Correlation IDs (`X-Request-Id`)**:
   - Send `GET /health/live` with header `X-Request-Id: req-health-001` -> Returns `200 OK` `{ "status": "ok" }` with response header `X-Request-Id: req-health-001` and zero database queries.
   - Send `GET /health/ready` -> Executes `SELECT 1` over `omnistock_app` without setting tenant context or querying tenant-owned tables, returning `200 OK` `{ "status": "ready" }`.
2. **Verify Strict Validation, Trusted Client IP Resolution & Two-Tier Webhook Rate Limiting**:
   - Send `POST /products` with an unknown body field (e.g., `"tenant_id": "uuid-other"` or `"unexpected": true`) -> Rejected by `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`) with `400 Bad Request` (`VALIDATION_ERROR`) in the canonical error envelope (`statusCode`, `error_code`, `message`, `request_id`, `timestamp`).
   - Send unauthenticated requests to `POST /sync/webhook/salla` with forged `X-Sync-Tenant-Slug: <victim_tenant_slug>` and forged `X-Forwarded-For` headers from an untrusted peer exceeding `RATE_LIMIT_WEBHOOK_IP_MAX` -> Rate limiter ignores arbitrary `X-Forwarded-For` headers when `req.socket.remoteAddress` is not in `TRUSTED_PROXY_IPS` (or resolves the first rightmost non-trusted hop when behind a configured trusted proxy), returns `429 Too Many Requests` (`RATE_LIMIT_EXCEEDED` with `Retry-After` header) keyed by `webhook:preauth:ip:${client_ip}` / `webhook:preauth:source_ip:${lower(source)}:${client_ip}`, while a valid HMAC-signed webhook from another IP for `<victim_tenant_slug>` still succeeds (proving unauthenticated requests never consume the victim tenant's post-HMAC quota).
   - Send valid HMAC-signed webhooks for `<tenant_slug>` exceeding `RATE_LIMIT_WEBHOOK_TENANT_MAX` -> Post-HMAC rate limiter returns `429 Too Many Requests` (`RATE_LIMIT_EXCEEDED` with `Retry-After`) keyed by `webhook:tenant:${verified_tenant_id}:${lower(source)}`.
   - Trigger graceful shutdown (`SIGTERM` / `SIGINT`) while a `SyncLog` job is in `Phase B` (and fails into `Phase C`) -> Verify `/health/ready` immediately returns `503` (`not_ready`), new worker claims stop, the in-flight job tracker remains active across `Phase A.1` (when applicable), `Phase A.2`, `Phase B`, and `Phase C` without releasing at intermediate transaction boundaries until `Phase C` commits, and TypeORM `DataSource` closes only after the drain procedure finishes (or logs a timeout warning after `SHUTDOWN_DRAIN_TIMEOUT_MS` without marking unfinished jobs as completed).
3. **Verify PostgreSQL Backup, Separate Role Bootstrap & Isolated Restore Verification**:
   - **Step A — Backup**: Create a portable logical archive using `pg_dump --format=custom --no-owner --no-acl -d omnistock -f omnistock.dump`. Keep `WEBHOOK_SECRET_ENCRYPTION_KEYS` and `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION` in external secret storage (never embedded in the database dump), retaining every key version present in `SELECT DISTINCT encryption_key_version FROM sync_webhook_credentials`.
   - **Step B — Separate Cluster Role & Target DB Bootstrap**: On the restore target, first execute `docker/postgres/init-roles.sql` to ensure `omnistock_migrator`, `omnistock_app` (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`), and `omnistock_preauth_auditor` (`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`) exist, and create an isolated restore verification database (`omnistock_restore_verify`) owned by `omnistock_migrator`.
   - **Step C — Restore Objects & Re-apply Role Grants**: Run `pg_restore --no-owner --no-acl --role=omnistock_migrator -U omnistock_migrator -d omnistock_restore_verify omnistock.dump`, then apply the role-ownership and least-privilege DML/function grants (`omnistock_preauth_auditor` ownership of `public.record_pre_auth_audit_log(text, jsonb)` and `omnistock_app` grants with `UPDATE, DELETE, TRUNCATE` revoked on `stock_movements`, `audit_logs`, and `sync_attempts`) before any runtime instance connects.
   - **Step D — Run Restore Verification (`scripts/verify-restore.sql`)**: Execute `scripts/verify-restore.sql` against `omnistock_restore_verify` to confirm:
     1. All 17 tenant-owned tables have `relrowsecurity = true` and `relforcerowsecurity = true` and their `<table>_tenant_isolation` policies exist;
     2. All 3 append-only triggers (`prevent_stock_movement_mutation`, `prevent_audit_log_mutation`, `prevent_sync_attempt_mutation`) are active in `pg_trigger`;
     3. Effective privilege checks (`has_table_privilege()`, `has_schema_privilege()`, `pg_has_role()`) confirm `omnistock_app` is not a member of `omnistock_migrator` or `omnistock_preauth_auditor`, owns 0 tables/schemas, and has no `UPDATE`/`DELETE`/`TRUNCATE` privilege on the 3 append-only tables; and
     4. Every `encryption_key_version` in `sync_webhook_credentials` is present in `WEBHOOK_SECRET_ENCRYPTION_KEYS`.
4. **Verify Canonical Developer Scripts & 8-Stage CI Quality Gate Pipeline**:
   - Execute the 8 mandatory quality gates in order:
     1. `npm ci`
     2. `npm run format:check`
     3. `npm run lint`
     4. `npm run typecheck` (`tsc --noEmit`)
     5. `npm run test:unit`
     6. `npm run migration:run && npm run test:integration` (`--runInBand`, executing runtime assertions as `omnistock_app`)
     7. `npm run test:e2e` (`--runInBand`, including 100-concurrent-order overselling test `T029` and cross-tenant isolation `T015`)
     8. `npm run build`
