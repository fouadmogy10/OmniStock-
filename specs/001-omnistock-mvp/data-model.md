# Data Model: OmniStock MVP

## Entity Ownership, Database Roles & Multi-Tenant Isolation Model

### 1. Entity Classification
- **Global / System Root Entity**:
  - **`Tenant` (`tenants`)**: Represents the top-level tenant organization itself (`id` is the primary tenant identifier). Managed only via system onboarding and tenant-scoped self-lookup; it does not have a parent `tenant_id` foreign key. Because `tenants` is the global root directory (not RLS-protected), internal background workers (`SyncRetryWorker`) and inbound webhook signature verification (`WebhookSignatureGuard`) may query active tenant records (`SELECT id, slug FROM tenants WHERE is_active = true`) before establishing a transaction-scoped `SET LOCAL app.current_tenant_id = '<tenant_uuid>'`.
- **Tenant-Owned Entities (RLS-Isolated — 17 Tables)**:
  - **`User` (`users`)**, **`AuditLog` (`audit_logs`)**, **`Customer` (`customers`)**, **`Category` (`categories`)**, **`Product` (`products`)**, **`Warehouse` (`warehouses`)**, **`InventoryItem` (`inventory_items`)**, **`LowStockAlert` (`low_stock_alerts`)**, **`StockMovement` (`stock_movements`)**, **`StockTransfer` (`stock_transfers`)**, **`StockTransferItem` (`stock_transfer_items`)**, **`Order` (`orders`)**, **`OrderItem` (`order_items`)**, **`OrderAllocation` (`order_allocations`)**, **`SyncWebhookCredential` (`sync_webhook_credentials`)**, **`SyncLog` (`sync_logs`)**, and **`SyncAttempt` (`sync_attempts`)**.
  - Every tenant-owned entity MUST include `tenant_id: UUID (Foreign Key -> Tenant.id)`.
  - Cross-table foreign keys between tenant-owned tables enforce composite tenant ownership `(tenant_id, <target_id>)` backed by explicit `UNIQUE (tenant_id, id)` (or wider composite `UNIQUE`) constraints on parent tables so cross-tenant associations are impossible at the database constraint layer in addition to RLS.

### 2. PostgreSQL Row-Level Security (RLS) & Context Evaluation
- **RLS Policy Pattern**: Every tenant-owned table (all 17 tables) enforces strict tenant isolation at the database layer via version-controlled SQL migrations:
  ```sql
  ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
  ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
  CREATE POLICY <table>_tenant_isolation ON <table>
    FOR ALL TO omnistock_app
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
  ```
- **Tenant Context Behavior**:
  - **Unset setting**: `current_setting('app.current_tenant_id', true)` returns `NULL` -> `NULLIF(..., '')::uuid` evaluates to `NULL` (0 rows returned on read/update/delete; writes rejected by `WITH CHECK`).
  - **Empty setting (`''`)**: `NULLIF('', '')::uuid` evaluates to `NULL` (0 rows returned on read/update/delete; writes rejected by `WITH CHECK`).
  - **Valid UUID**: Enforces strict `tenant_id` equality on both `USING` and `WITH CHECK`.
  - **Malformed UUID**: Fails closed with a PostgreSQL UUID cast error (`22P02 invalid_text_representation`); never grants access or broadens visibility.
- **Transaction-Scoped Context**:
  - For authenticated user requests, `TenantInterceptor` extracts `tenant_id` exclusively from the authenticated server-side JWT context (never trusting client-provided headers, query parameters, or body fields) and sets `SET LOCAL app.current_tenant_id = '<tenant_uuid>'` inside the active database transaction.
  - For inbound external webhooks (`POST /sync/webhook/{source}`), `WebhookSignatureGuard` resolves `Tenant` (`is_active = true`) from `X-Sync-Tenant-Slug` in `tenants`, sets `SET LOCAL app.current_tenant_id = '<tenant_uuid>'`, and verifies the active `SyncWebhookCredential` HMAC-SHA256 signature.
  - For background retries (`SyncRetryWorker`), the worker enumerates active `tenant_id`s from `tenants` (`WHERE is_active = true ORDER BY id ASC`) and opens per-tenant transactions with `SET LOCAL app.current_tenant_id = '<tenant_uuid>'`.
  - Session-level `SET` MUST NOT be used with pooled connections.

### 3. Database Role Separation & Ownership
1. **Migration / Admin Role (`omnistock_migrator`)**:
   - Owns all application schemas, tables, sequences, views, and triggers.
   - Executes version-controlled DDL migrations (`up` and `down`).
   - Is never used by normal application runtime requests.
2. **Runtime Application Role (`omnistock_app`)**:
   - Must **not** own any tenant tables or schemas.
   - Created with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`.
   - Must **not** have DDL (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`), ownership, trigger-modification, or RLS policy-modification privileges.
   - Receives only required DML privileges (`SELECT, INSERT, UPDATE, DELETE` on mutable tables).
   - Receives only `SELECT, INSERT` on append-only `stock_movements`, `audit_logs`, and `sync_attempts` tables, with `UPDATE, DELETE, TRUNCATE` revoked.

---

## 1. Tenant, Security, RBAC & Customers

### Tenant (Global / System Root Entity — `tenants`)
- `id`: UUID (Primary Key)
- `name`: String (`NOT NULL`)
- `slug`: String (`NOT NULL`, Unique, normalized lowercase)
- `is_active`: Boolean (`NOT NULL`, Default: `true`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *PostgreSQL Constraints & Indexes*:
  - `UNIQUE (lower(slug))`
  - `CREATE INDEX idx_tenants_active_id ON tenants (is_active, id ASC);` (used by `SyncRetryWorker` to iterate active tenants deterministically)

### User (Tenant-Owned — `users`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `email`: String (`NOT NULL`, normalized lowercase)
- `password_hash`: String (`NOT NULL`)
- `role`: Enum (`ADMIN`, `MANAGER`, `VIEWER`) (`NOT NULL`)
- `is_active`: Boolean (`NOT NULL`, Default: `true`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- `updated_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *PostgreSQL Constraints & Authorization Invariants*:
  - `UNIQUE (tenant_id, lower(email))`
  - `UNIQUE (tenant_id, id)`
  - **DB-Backed Role Evaluation (`F10-3`)**: `TenantInterceptor` loads the current `User` row (`id = jwt.sub AND is_active = true`) from `users` inside the active tenant transaction, and `PermissionsGuard` evaluates `User.role` from that database row (never trusting stale role claims inside the JWT).
  - **Last-Active-Admin Invariant (`F10-3`)**: Every active tenant must retain at least one active `ADMIN` (`role = 'ADMIN' AND is_active = true`). `PATCH /users/{id}` locks active `ADMIN` rows for the tenant with `SELECT ... FOR UPDATE` and rejects demoting or deactivating the last active `ADMIN` with `409 Conflict` (`LAST_ACTIVE_ADMIN_REQUIRED`).

### AuditLog (Tenant-Owned, Foundational Append-Only Security & Activity Log — `audit_logs`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, where applicable; `NOT NULL` for all tenant-attributable events, nullable only for unattributable pre-authentication security events)
- `actor_user_id`: UUID (Foreign Key -> `User.id` `ON DELETE SET NULL`, where applicable; nullable for unauthenticated login attempts or system/webhook operations)
- `action`: String (e.g., `AUTH_LOGIN_SUCCESS`, `AUTH_LOGIN_FAILURE`, `AUTH_TOKEN_INVALID`, `CROSS_TENANT_ACCESS_DENIED`, `USER_CREATED`, `USER_UPDATED`, `INVENTORY_ADJUSTED`, `LOW_STOCK_THRESHOLD_UPDATED`, `LOW_STOCK_ALERT_TRIGGERED`, `LOW_STOCK_ALERT_RESOLVED`, `STOCK_TRANSFER_DISPATCHED`, `STOCK_TRANSFER_RECEIVED`, `STOCK_TRANSFER_CANCELLED`, `ORDER_SHIPPED`, `ORDER_CANCELLED`, `SYNC_CREDENTIAL_CREATED`, `SYNC_CREDENTIAL_REVOKED`, `SYNC_WEBHOOK_AUTH_FAILURE`, `SYNC_MANUAL_RETRY`, `ADMIN_ACTION`)
- `entity_type`: String (e.g., `Auth`, `User`, `Customer`, `Category`, `Product`, `Warehouse`, `InventoryItem`, `LowStockAlert`, `StockTransfer`, `Order`, `SyncWebhookCredential`, `SyncLog`, `Tenant`)
- `entity_id`: UUID (Nullable where not tied to a single entity instance)
- `metadata`: JSONB (Structured context such as reason, IP, request path, before/after summary — never containing raw passwords, JWTs, or webhook secrets)
- `created_at`: Timestamp (Default: `CURRENT_TIMESTAMP`, `NOT NULL`, Immutable)
- *Phase 2 ORM & Foreign Key Integrity*:
  - At the PostgreSQL schema level (created in initial SQL migration `T038`), `audit_logs.tenant_id` and `audit_logs.actor_user_id` enforce explicit SQL `FOREIGN KEY` constraints referencing `tenants(id)` and `users(id)`.
  - At the TypeORM entity level in Phase 2 (`T042`), `tenant_id` and `actor_user_id` are mapped as scalar UUID columns (`@Column({ type: 'uuid', nullable: true })`) so that Phase 2 foundational audit logging compiles and runs independently without importing Phase 3 `Tenant` or `User` entity classes.
- *Access & Isolation Rules*:
  - **A. Tenant-Scoped Runtime Requests (`omnistock_app`)**:
    - Governed by `audit_logs_tenant_isolation` (`FOR ALL TO omnistock_app USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)`).
    - May `INSERT` audit records directly only when `tenant_id` is non-null and matches the active tenant context.
    - May `SELECT` only records belonging to the active tenant.
    - Must **never** read `tenant_id IS NULL` records and must **never** directly insert `tenant_id IS NULL` records.
  - **B. Unattributable Pre-Authentication Events (`tenant_id IS NULL`)**:
    - May be inserted **only** through a narrowly scoped server-side PostgreSQL `SECURITY DEFINER` function `public.record_pre_auth_audit_log(p_action text, p_metadata jsonb)` owned by dedicated non-login role `omnistock_preauth_auditor` (`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`) with `SET search_path = pg_catalog, public`.
    - `omnistock_preauth_auditor` has **only** `INSERT` privilege on `public.audit_logs` (zero `SELECT`, `UPDATE`, `DELETE`, or access to any other table) and is constrained by a dedicated RLS policy:
      ```sql
      CREATE POLICY audit_logs_preauth_insert ON audit_logs
        FOR INSERT TO omnistock_preauth_auditor
        WITH CHECK (
          tenant_id IS NULL
          AND actor_user_id IS NULL
          AND entity_type = 'Auth'
          AND action IN ('AUTH_LOGIN_FAILURE', 'AUTH_TOKEN_INVALID', 'SYNC_WEBHOOK_AUTH_FAILURE')
        );
      ```
    - `EXECUTE` on `public.record_pre_auth_audit_log(text, jsonb)` is revoked from `PUBLIC` and granted only to `omnistock_app`. It is called exclusively by internal server-side authentication failure handlers, never exposed through a public generic `AuditLog` insertion endpoint, never grants general tenant-table access without tenant context, and its rows are never readable by tenant-scoped runtime requests.
  - **C. Append-Only Enforcement**:
    - Protected at the PostgreSQL layer via a `BEFORE UPDATE OR DELETE` trigger (`prevent_audit_log_mutation()`) that unconditionally raises an exception on any `UPDATE` or `DELETE`, combined with revoking `UPDATE, DELETE, TRUNCATE` on `audit_logs` from `omnistock_app` and `omnistock_preauth_auditor` (preserving `SELECT, INSERT` for `omnistock_app` and `INSERT` for `omnistock_preauth_auditor`).
- *Separation from `StockMovement`*: `AuditLog` records security and business activity across all modules, whereas `StockMovement` is strictly the immutable quantitative inventory ledger.

### Customer (Tenant-Owned — `customers`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `name`: String (`NOT NULL`, non-empty)
- `email`: String (`NULLABLE`, normalized lowercase)
- `phone`: String (`NULLABLE`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- `updated_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *PostgreSQL Constraints*:
  - Tenant-scoped partial unique index on email: `CREATE UNIQUE INDEX uq_customers_tenant_email ON customers (tenant_id, lower(email)) WHERE email IS NOT NULL;` (never enforces global uniqueness across tenants; permits multiple customers without an email).
  - Tenant-scoped partial unique index on phone: `CREATE UNIQUE INDEX uq_customers_tenant_phone ON customers (tenant_id, phone) WHERE phone IS NOT NULL;`
  - `UNIQUE (tenant_id, id)` for tenant-safe composite foreign key references from `orders`.

---

## 2. Catalog, Warehouses, Inventory, Low-Stock Alerts & Transfers

### Category (Tenant-Owned, Flat Classification — `categories`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `name`: String (`NOT NULL`, non-empty)
- `description`: Text (`NULLABLE`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *Design & Constraints*:
  - Categories are flat (non-nested) in the MVP (`no parent_id`).
  - Unique per tenant: `CREATE UNIQUE INDEX uq_categories_tenant_name ON categories (tenant_id, lower(name));`
  - `UNIQUE (tenant_id, id)` for tenant-safe composite foreign key references from `products`.

### Product (Tenant-Owned, Unified SKU & Variant Model — `products`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `category_id`: UUID (Foreign Key -> `Category.id` `ON DELETE SET NULL`, `NULLABLE`)
- `parent_product_id`: UUID (Self-Foreign Key -> `Product.id` `ON DELETE RESTRICT`, `NULLABLE`)
- `is_variant_parent`: Boolean (`NOT NULL`, Default: `false`)
- `sku`: String (`NOT NULL`, non-empty)
- `barcode`: String (`NULLABLE`)
- `name`: String (`NOT NULL`, non-empty)
- `description`: Text (`NULLABLE`)
- `variant_attributes`: JSONB (`NULLABLE`, e.g., `{"color": "Black", "storage": "256GB"}`)
- `price`: Decimal(12, 2) (`NOT NULL`, `CHECK (price >= 0)`)
- `is_active`: Boolean (`NOT NULL`, Default: `true`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- `updated_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *Variant & Stock-Tracking Semantics*:
  - **Standalone Product**: `parent_product_id IS NULL` and `is_variant_parent = false`. Directly stock-tracked and orderable.
  - **Variant Parent (Container)**: `parent_product_id IS NULL` and `is_variant_parent = true`. Still has required `sku` (`NOT NULL`) and `price` (`NOT NULL`, `price >= 0`) fields, but is not sellable and **cannot hold stock (`InventoryItem`), movements (`StockMovement`), transfer items (`StockTransferItem`), or order items (`OrderItem`)**.
  - **Child Variant SKU**: `parent_product_id IS NOT NULL` and `is_variant_parent = false` (referencing a parent with `is_variant_parent = true` in the same tenant). Directly stock-tracked and orderable via its own `id`, `sku`, `barcode`, and `price`.
- *PostgreSQL Constraints*:
  - `UNIQUE (tenant_id, id)` (referenced by composite FKs from `products`, `inventory_items`, `low_stock_alerts`, `stock_movements`, `stock_transfer_items`, and `order_items`)
  - `UNIQUE (tenant_id, sku)`
  - Tenant-safe barcode uniqueness: `CREATE UNIQUE INDEX uq_products_tenant_barcode ON products (tenant_id, barcode) WHERE barcode IS NOT NULL;`
  - `CHECK (price >= 0)`
  - `CHECK (NOT (is_variant_parent = true AND parent_product_id IS NOT NULL))` (prevents multi-level variant nesting)
  - Composite FKs: `(tenant_id, category_id) REFERENCES categories(tenant_id, id) ON DELETE SET NULL` and `(tenant_id, parent_product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT`.

### Warehouse (Tenant-Owned — `warehouses`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `name`: String (`NOT NULL`, non-empty)
- `location`: String (`NOT NULL`)
- `priority`: Integer (`NOT NULL`, Default: `100`, `CHECK (priority >= 1)` — lower integer means higher allocation priority; deterministic tie-breaker: `priority ASC, created_at ASC, id ASC`)
- `is_active`: Boolean (`NOT NULL`, Default: `true`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *PostgreSQL Constraints & Deactivation Rule*:
  - `UNIQUE (tenant_id, id)` (referenced by composite FKs from `inventory_items`, `low_stock_alerts`, `stock_movements`, `stock_transfers`, and `order_allocations`)
  - `CHECK (priority >= 1)`
  - `UNIQUE (tenant_id, lower(name))`
  - Index on `(tenant_id, is_active, priority ASC, created_at ASC, id ASC)`
  - **Deactivation Commitment Guard (`A5-3`)**: Deactivating a warehouse (`is_active: false`) via `PATCH /warehouses/{id}` locks all `InventoryItem` rows for that warehouse (`SELECT ... FOR UPDATE`) and rejects the transition with `409 Conflict` (`WAREHOUSE_HAS_ACTIVE_STOCK_COMMITMENTS`) if any row has `reserved > 0` or `in_transit > 0`.

### InventoryItem (Tenant-Owned — `inventory_items`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `product_id`: UUID (Foreign Key -> `Product.id` `ON DELETE RESTRICT`, `NOT NULL` — must reference a concrete sellable SKU with `is_variant_parent = false`)
- `warehouse_id`: UUID (Foreign Key -> `Warehouse.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `on_hand`: Integer (Physical stock in warehouse, `NOT NULL`, Default: `0`)
- `reserved`: Integer (Committed stock for `ALLOCATED` orders, `NOT NULL`, Default: `0`)
- `available`: Derived Integer (`on_hand - reserved`, computed read-only field/generated expression — **never independently writable**)
- `in_transit`: Integer (Inbound stock from dispatched `IN_TRANSIT` stock transfers, `NOT NULL`, Default: `0` — **never counted in `on_hand` or `available` in either source or destination warehouse**)
- `low_stock_threshold`: Integer (`NULLABLE`, Default: `NULL`, `CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0)` — per-warehouse-SKU low-stock threshold; when `NULL`, alerting is disabled for this warehouse SKU)
- *PostgreSQL Constraints & Locking Order*:
  - `UNIQUE (tenant_id, id)`
  - `UNIQUE (tenant_id, id, product_id, warehouse_id)` (referenced by composite FK from `low_stock_alerts` to guarantee exact `product_id` and `warehouse_id` matching)
  - `CHECK (on_hand >= 0)`
  - `CHECK (reserved >= 0)`
  - `CHECK (reserved <= on_hand)`
  - `CHECK (in_transit >= 0)`
  - `CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0)`
  - Unique index on `(tenant_id, product_id, warehouse_id)`
  - Composite FKs: `(tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT` and `(tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id) ON DELETE RESTRICT`
  - **Global Deterministic Locking Order**: Across all inventory mutations (allocation, shipment, cancellation, transfer dispatch/receipt, and manual adjustment), candidate `InventoryItem` rows are always locked via `SELECT ... FOR UPDATE` in `(product_id ASC, warehouse_id ASC)` order.

### LowStockAlert (Tenant-Owned — `low_stock_alerts`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `inventory_item_id`: UUID (Foreign Key -> `InventoryItem.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `product_id`: UUID (Foreign Key -> `Product.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `warehouse_id`: UUID (Foreign Key -> `Warehouse.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `threshold`: Integer (`NOT NULL`, `CHECK (threshold >= 0)` — snapshot of `InventoryItem.low_stock_threshold` when triggered/updated)
- `current_available`: Integer (`NOT NULL`, `CHECK (current_available >= 0)` — latest observed `available` quantity while alert is `OPEN`, or `available` quantity at resolution)
- `status`: Enum (`OPEN`, `RESOLVED`) (`NOT NULL`, Default: `OPEN`)
- `triggered_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- `resolved_at`: Timestamp (`NULLABLE` — `NULL` when `status = 'OPEN'`, non-null when `status = 'RESOLVED'`)
- `updated_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *PostgreSQL Constraints & Alert Lifecycle Rules*:
  - `CHECK (threshold >= 0)`
  - `CHECK (current_available >= 0)`
  - `CHECK ((status = 'OPEN' AND resolved_at IS NULL) OR (status = 'RESOLVED' AND resolved_at IS NOT NULL))`
  - **Duplicate Active Alert Prevention**: `CREATE UNIQUE INDEX uq_low_stock_alerts_open ON low_stock_alerts (tenant_id, inventory_item_id) WHERE status = 'OPEN';` (guarantees at most one `OPEN` alert per warehouse SKU at any time).
  - Index on `(tenant_id, status, triggered_at DESC)` for dashboard and alert list queries.
  - **Historical Alert Preservation (`F2-1`, `F3-3`)**:
    - Composite FKs use `ON DELETE RESTRICT` across all parent references:
      - `(tenant_id, inventory_item_id, product_id, warehouse_id) REFERENCES inventory_items(tenant_id, id, product_id, warehouse_id) ON DELETE RESTRICT`
      - `(tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT`
      - `(tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id) ON DELETE RESTRICT`
    - Resolved alerts (`status = 'RESOLVED'`) are permanently retained for historical inspection and are never cascade-deleted (`InventoryItem` rows are never deleted in MVP).
    - Deactivating a `Product` (`is_active = false`) or `Warehouse` (`is_active = false`) does not delete, mutate, or resolve `LowStockAlert` rows; however, `GET /dashboard/summary` `low_stock_alerts_count` counts only `OPEN` alerts belonging to active products in active warehouses.

### StockMovement (Tenant-Owned, Immutable Inventory Ledger — `stock_movements`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `product_id`: UUID (Foreign Key -> `Product.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `warehouse_id`: UUID (Foreign Key -> `Warehouse.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `delta`: Integer (e.g., `+10`, `-5`; `NOT NULL`)
- `type`: Enum (`ADJUSTMENT`, `SALE`, `TRANSFER`, `RETURN`) (`NOT NULL` — `RETURN` is a reserved enum value in MVP; no public return workflow or endpoint creates a `RETURN` movement in MVP, and any future return workflow that increments `on_hand` must update `InventoryItem` and evaluate `LowStockAlert` inside the same transaction; `F2-2`)
- `reference_id`: UUID (Nullable; e.g., `Order.id` for `SALE`, `StockTransfer.id` for `TRANSFER`)
- `created_at`: Timestamp (Default: `CURRENT_TIMESTAMP`, `NOT NULL`)
- *PostgreSQL Constraints & Append-Only Enforcement*:
  - `CHECK (delta <> 0)`
  - Index on `(tenant_id, created_at DESC, id DESC)` and `(tenant_id, product_id, warehouse_id, created_at DESC)`
  - Composite FKs: `(tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT` and `(tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id) ON DELETE RESTRICT`
  - **Database-Level Immutability**: Enforced authoritatively at the PostgreSQL layer via a `BEFORE UPDATE OR DELETE` trigger (`prevent_stock_movement_mutation()`) that raises an exception on any `UPDATE` or `DELETE` statement, combined with database role privilege restrictions (`SELECT, INSERT` granted to `omnistock_app`; `UPDATE, DELETE, TRUNCATE` revoked). Legitimate `INSERT` operations remain permitted through `omnistock_app` within transactional inventory workflows.

### StockTransfer (Tenant-Owned — `stock_transfers`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `source_warehouse_id`: UUID (Foreign Key -> `Warehouse.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `destination_warehouse_id`: UUID (Foreign Key -> `Warehouse.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `status`: Enum (`DRAFT`, `IN_TRANSIT`, `RECEIVED`, `CANCELLED`) (`NOT NULL`, Default: `DRAFT`)
- `notes`: Text (`NULLABLE`)
- `dispatched_at`: Timestamp (`NULLABLE`)
- `received_at`: Timestamp (`NULLABLE`)
- `cancelled_at`: Timestamp (`NULLABLE`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- `updated_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *PostgreSQL Constraints & State Rules*:
  - `UNIQUE (tenant_id, id)` (referenced by composite FK from `stock_transfer_items`)
  - `CHECK (source_warehouse_id <> destination_warehouse_id)` (prevents same-warehouse transfers)
  - Composite FKs: `(tenant_id, source_warehouse_id) REFERENCES warehouses(tenant_id, id)` and `(tenant_id, destination_warehouse_id) REFERENCES warehouses(tenant_id, id)` (prevents cross-tenant warehouse transfers)
  - **Header-Row Concurrency & Allowed Transitions**:
    - Every state-transition operation (`dispatch`, `receive`, `cancel`) MUST first lock the `StockTransfer` header row using `SELECT ... FOR UPDATE` before validating `StockTransfer.status` inside the same transaction so concurrent duplicate requests cannot apply stock changes more than once (`409 Conflict` `INVALID_TRANSFER_TRANSITION` if not in the required prior state).
    - `DRAFT -> IN_TRANSIT` (`dispatch`): Locks `StockTransfer` row (`SELECT FOR UPDATE`), locks source and destination `InventoryItem` rows in `(product_id ASC, warehouse_id ASC)` order, verifies source `available >= quantity` for every item, decrements source `on_hand -= quantity`, inserts a source `StockMovement` (`type: TRANSFER`, `delta: -quantity`, `reference_id: transfer.id`), increments destination `in_transit += quantity`, evaluates `LowStockAlert` on source `InventoryItem` rows, and logs `STOCK_TRANSFER_DISPATCHED` in `AuditLog`.
    - `IN_TRANSIT -> RECEIVED` (`receive`): **Partial transfer receipt is NOT supported in MVP** — receipt always receives the full dispatched `quantity` for every `StockTransferItem` (receipt cannot exceed dispatched quantities). Locks `StockTransfer` row (`SELECT FOR UPDATE`), locks destination `InventoryItem` rows in `(product_id ASC, warehouse_id ASC)` order, decrements destination `in_transit -= quantity`, increments destination `on_hand += quantity`, inserts a destination `StockMovement` (`type: TRANSFER`, `delta: +quantity`, `reference_id: transfer.id`), evaluates `LowStockAlert` resolution on destination `InventoryItem` rows, and logs `STOCK_TRANSFER_RECEIVED` in `AuditLog`.
    - `DRAFT -> CANCELLED` (`cancel`): Locks `StockTransfer` row (`SELECT FOR UPDATE`); allowed only from `DRAFT` (no inventory changes occurred), logging `STOCK_TRANSFER_CANCELLED` in `AuditLog`. Cancellation from `IN_TRANSIT`, `RECEIVED`, or `CANCELLED` is rejected (`409 Conflict` `INVALID_TRANSFER_TRANSITION`).

### StockTransferItem (Tenant-Owned — `stock_transfer_items`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `stock_transfer_id`: UUID (Foreign Key -> `StockTransfer.id` `ON DELETE CASCADE`, `NOT NULL`)
- `product_id`: UUID (Foreign Key -> `Product.id` `ON DELETE RESTRICT`, `NOT NULL` — must reference a sellable SKU with `is_variant_parent = false`)
- `quantity`: Integer (`NOT NULL`, `CHECK (quantity > 0)`)
- *PostgreSQL Constraints*:
  - `CHECK (quantity > 0)`
  - `UNIQUE (tenant_id, stock_transfer_id, product_id)`
  - Composite FKs: `(tenant_id, stock_transfer_id) REFERENCES stock_transfers(tenant_id, id)` and `(tenant_id, product_id) REFERENCES products(tenant_id, id)`

---

## 3. Orders & Split Allocation

### Order (Tenant-Owned — `orders`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `customer_id`: UUID (Foreign Key -> `Customer.id` `ON DELETE RESTRICT`, `NOT NULL` — replaces legacy `customer_name` string as the authoritative customer relationship)
- `customer_name_snapshot`: String (`NOT NULL` — captured from `Customer.name` at order creation/submission for historical accuracy)
- `customer_email_snapshot`: String (`NULLABLE` — captured from `Customer.email` at order creation/submission)
- `status`: Enum (`DRAFT`, `PENDING`, `ALLOCATED`, `SHIPPED`, `CANCELLED`) (`NOT NULL`, Default: `DRAFT`)
- `total_amount`: Decimal(12, 2) (`NOT NULL`, Default: `0.00`, `CHECK (total_amount >= 0)`)
- `shipped_at`: Timestamp (`NULLABLE`)
- `cancelled_at`: Timestamp (`NULLABLE`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- `updated_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *PostgreSQL Constraints & State-Transition Concurrency*:
  - `UNIQUE (tenant_id, id)` (referenced by composite FKs from `order_items` and `sync_logs`)
  - Composite FK: `(tenant_id, customer_id) REFERENCES customers(tenant_id, id)`
  - `CHECK (total_amount >= 0)`
  - Index on `(tenant_id, status, created_at DESC)` for dashboard and order list queries.
  - **Header-Row Locking**: Every state-transition operation on an existing order (`submit`, `allocate`, `ship`, `cancel`, `PATCH`) MUST first lock the `Order` header row using `SELECT ... FOR UPDATE` before validating `Order.status` inside the same transaction so concurrent duplicate requests cannot apply inventory changes more than once (returning `409 Conflict` `INVALID_ORDER_TRANSITION` on invalid/repeated transitions).

### OrderItem (Tenant-Owned — `order_items`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `order_id`: UUID (Foreign Key -> `Order.id` `ON DELETE CASCADE`, `NOT NULL`)
- `product_id`: UUID (Foreign Key -> `Product.id` `ON DELETE RESTRICT`, `NOT NULL` — must reference a sellable SKU with `is_variant_parent = false`)
- `quantity`: Integer (`NOT NULL`, `CHECK (quantity > 0)`)
- `unit_price`: Decimal(12, 2) (`NOT NULL`, `CHECK (unit_price >= 0)`)
- *Deprecated / Removed Field Note*: The single-warehouse field `allocated_warehouse_id` on `OrderItem` (and top-level `Order`) is **removed** in favor of the dedicated `OrderAllocation` entity to support split warehouse allocation.
- *PostgreSQL Constraints*:
  - `UNIQUE (tenant_id, id)`
  - `UNIQUE (tenant_id, id, order_id, product_id)` (referenced by composite FK from `order_allocations` to guarantee exact `order_id` and `product_id` matching between an allocation and its parent `OrderItem`)
  - `CHECK (quantity > 0)`
  - `CHECK (unit_price >= 0)`
  - `UNIQUE (tenant_id, order_id, product_id)`
  - Composite FKs: `(tenant_id, order_id) REFERENCES orders(tenant_id, id)` and `(tenant_id, product_id) REFERENCES products(tenant_id, id)`

### OrderAllocation (Tenant-Owned, Split Warehouse Allocation — `order_allocations`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `order_id`: UUID (Foreign Key -> `Order.id` `ON DELETE CASCADE`, `NOT NULL`)
- `order_item_id`: UUID (Foreign Key -> `OrderItem.id` `ON DELETE CASCADE`, `NOT NULL`)
- `product_id`: UUID (Foreign Key -> `Product.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `warehouse_id`: UUID (Foreign Key -> `Warehouse.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `allocated_quantity`: Integer (`NOT NULL`, `CHECK (allocated_quantity > 0)`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *PostgreSQL Constraints & Allocation Invariants*:
  - `CHECK (allocated_quantity > 0)`
  - `UNIQUE (tenant_id, order_item_id, warehouse_id)`
  - Composite FKs:
    - `(tenant_id, order_item_id, order_id, product_id) REFERENCES order_items(tenant_id, id, order_id, product_id) ON DELETE CASCADE` (guarantees at the database level that an `OrderAllocation` cannot reference an `OrderItem` with a different `order_id` or `product_id`)
    - `(tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id) ON DELETE RESTRICT`
  - **All-or-Nothing Invariant**: When `Order.status IN ('ALLOCATED', 'SHIPPED')`, for every `OrderItem` in the order, $\sum \text{OrderAllocation.allocated\_quantity} = \text{OrderItem.quantity}$. If complete allocation across active warehouses is impossible for any item, the transaction rolls back and zero `OrderAllocation` rows or `InventoryItem.reserved` increments are persisted.

---

## 4. Synchronization, Webhook Credentials, Retries & Attempt History (`F7`, `F10-1`, `A9`)

### SyncWebhookCredential (Tenant-Owned, Inbound Channel Signing Credential — `sync_webhook_credentials`)
- `id`: UUID (Primary Key)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `source`: String (`NOT NULL`, non-empty, normalized lowercase, e.g., `"salla"`, `"shopify"`)
- `secret_hash`: String (`VARCHAR(64) NOT NULL`, 64-character lowercase hexadecimal `SHA-256(UTF8(webhook_secret))` digest used solely as a non-reversible fingerprint/lookup value and **never** as an HMAC key — the canonical 64-character lowercase hex `webhook_secret` is returned **exactly once** at provisioning and never stored in PostgreSQL)
- `encrypted_secret`: String (`VARCHAR(128) NOT NULL`, **128-character lowercase hexadecimal** AES-256-GCM ciphertext of `Buffer.from(webhook_secret, 'utf8')` — the 64 UTF-8 bytes of the 64-character lowercase hex string `webhook_secret`, NOT the 32 decoded random bytes — encrypted using the 32-byte key for `encryption_key_version` from `WEBHOOK_SECRET_ENCRYPTION_KEYS`, which is never stored in PostgreSQL)
- `encryption_iv`: String (`VARCHAR(24) NOT NULL`, fresh 12-byte / 96-bit cryptographically secure random AES-GCM initialization vector / nonce generated via CSPRNG per encryption operation and encoded as 24 lowercase hexadecimal characters; never reused with the same key)
- `encryption_auth_tag`: String (`VARCHAR(32) NOT NULL`, 16-byte / 128-bit AES-GCM authentication tag encoded as 32 lowercase hexadecimal characters)
- `encryption_key_version`: Integer (`INTEGER NOT NULL`, `CHECK (encryption_key_version >= 1)` — positive integer identifying the key version in `WEBHOOK_SECRET_ENCRYPTION_KEYS`; new credentials encrypt with `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION`, and both encryption and decryption bind the exact same Additional Authenticated Data `AAD = UTF8("${tenant_id}:${lower(source)}:${encryption_key_version}")`)
- `is_active`: Boolean (`NOT NULL`, Default: `true`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- `revoked_at`: Timestamp (`NULLABLE` — `NULL` when `is_active = true`, non-null when `is_active = false`)
- *PostgreSQL Constraints & Indexes*:
  - `UNIQUE (tenant_id, id)`
  - **Nonce Collision Guard per Key Version (`F7-CRYPTO-3`)**: `UNIQUE (encryption_key_version, encryption_iv)` (database collision guard complementing CSPRNG nonce generation; if a collision ever occurs on `(encryption_key_version, encryption_iv)`, `SyncCredentialService` discards the collided nonce, generates a fresh 12-byte CSPRNG nonce, recomputes ciphertext and auth tag, and retries safely without reusing the failed nonce)
  - `CHECK (secret_hash ~ '^[0-9a-f]{64}$')`
  - `CHECK (encrypted_secret ~ '^[0-9a-f]{128}$')`
  - `CHECK (encryption_iv ~ '^[0-9a-f]{24}$')`
  - `CHECK (encryption_auth_tag ~ '^[0-9a-f]{32}$')`
  - `CHECK (encryption_key_version >= 1)`
  - `CHECK ((is_active = true AND revoked_at IS NULL) OR (is_active = false AND revoked_at IS NOT NULL))`
  - **Active Credential Uniqueness per `(tenant_id, source)`**:
    ```sql
    CREATE UNIQUE INDEX uq_sync_webhook_credentials_active_source
      ON sync_webhook_credentials (tenant_id, lower(source))
      WHERE is_active = true AND revoked_at IS NULL;
    ```
  - **Versioned Keyring & Rotation Rules (`F7-CRYPTO-1`)**:
    - `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION` (positive integer `>= 1`) and `WEBHOOK_SECRET_ENCRYPTION_KEYS` (`<version>:<64-lowercase-hex-chars>,...`) are loaded from protected environment/KMS configuration at startup. Every `hexKey` is explicitly validated against `/^[0-9a-f]{64}$/` **before** calling `Buffer.from(hexKey, 'hex')` and verified to decode into a `Buffer` of **exactly 32 bytes** (`byteLength === 32`), and `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION` must exist in the keyring (failing startup closed on any key failing `/^[0-9a-f]{64}$/`, duplicate/invalid version, missing current version, or decoded length `!== 32` bytes; never falling back to another key).
    - During key rotation, the new key is added to `WEBHOOK_SECRET_ENCRYPTION_KEYS` while retaining all historical keys referenced by stored credentials, and `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION` is updated for new credential encryption. Existing credentials remain decryptable via their persisted `encryption_key_version` and may be atomically re-encrypted in place (`SyncCredentialService.reencryptCredentialsToCurrentKeyVersion()`) under the current key version using a fresh 12-byte CSPRNG `encryption_iv` and updated `AAD` without changing `webhook_secret` or `secret_hash`. Historical keys are removed only after verifying that zero stored credentials (active or retained revoked records) reference that `encryption_key_version`.
  - **Verification Scheme (`F10-1`, `F7-CRYPTO-2`, `F7-CRYPTO-3`)**: Inbound webhooks to `POST /sync/webhook/{source}` preserve the raw unparsed HTTP request `Buffer` (`rawBody: true` -> `req.rawBody`), load the active `SyncWebhookCredential`, look up the 32-byte key for `credential.encryption_key_version` in `WEBHOOK_SECRET_ENCRYPTION_KEYS` (failing closed with `401 WEBHOOK_AUTH_UNAUTHORIZED` if the key version is absent or GCM tag verification fails), decrypt `encrypted_secret` **only in memory** using AES-256-GCM with `encryption_iv`, `encryption_auth_tag`, and `AAD = UTF8("${tenant_id}:${lower(source)}:${encryption_key_version}")` to recover the 64-character lowercase hex string `webhook_secret`, validate `X-Sync-Signature` against `^v1=[0-9a-f]{64}$`, compute `expectedSigBuf = createHmac('sha256', Buffer.from(webhook_secret, 'utf8')).update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), req.rawBody])).digest()` (both sender and server use `Buffer.from(webhook_secret, 'utf8')` as the HMAC key without hex-decoding or SHA-256 derivation and concatenate the UTF-8 `${timestamp}.` prefix directly with the raw request body `Buffer`), verify both 32-byte digest buffers have equal byte length, and compare them using constant-time `crypto.timingSafeEqual` within a strict `±300s` replay window on `X-Sync-Timestamp`.

### SyncLog (Tenant-Owned, Logical Synchronization Event & Retry State — `sync_logs`)
- `id`: UUID (Primary Key — logical synchronization event identifier)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `source`: String (`NOT NULL`, non-empty, normalized lowercase, e.g., `"salla"`, `"shopify"` — external provider/channel identifier)
- `external_id`: String (`NOT NULL`, non-empty — external channel's idempotency key from `X-Sync-External-Id`)
- `event_type`: Enum (`ORDER_CREATE`) (`NOT NULL`, Default: `'ORDER_CREATE'`)
- `status`: Enum (`PENDING`, `PROCESSING`, `SUCCEEDED`, `RETRY_SCHEDULED`, `FAILED_PERMANENT`) (`NOT NULL`, Default: `'PENDING'`)
- `attempt_count`: Integer (`NOT NULL`, Default: `0`, `CHECK (attempt_count >= 0 AND attempt_count <= max_attempts)` — incremented by `1` **only** in Phase A Claim TX when transitioning `PENDING | RETRY_SCHEDULED -> PROCESSING`)
- `max_attempts`: Integer (`NOT NULL`, Default: `5`, `CHECK (max_attempts = 5)`)
- `next_retry_at`: Timestamp (`NULLABLE` — non-null **only** when `status = 'RETRY_SCHEDULED'`)
- `next_trigger_source`: Enum (`AUTO_RETRY`, `MANUAL_RETRY`) (`NULLABLE` — non-null **only** when `status = 'RETRY_SCHEDULED'`)
- `processing_started_at`: Timestamp (`NULLABLE` — non-null **only** when `status = 'PROCESSING'`)
- `lease_expires_at`: Timestamp (`NULLABLE` — non-null **only** when `status = 'PROCESSING'`, set to `processing_started_at + INTERVAL '60 seconds'`)
- `lease_token`: UUID (`NULLABLE` — non-null **only** when `status = 'PROCESSING'`, uniquely identifying the active processing lease)
- `active_trigger_source`: Enum (`WEBHOOK`, `AUTO_RETRY`, `MANUAL_RETRY`) (`NULLABLE` — non-null **only** when `status = 'PROCESSING'`)
- `last_pg_sqlstate`: String (`VARCHAR(5)`, `NULLABLE` — PostgreSQL 5-character SQLSTATE code only, e.g., `'40P01'`, `'55P03'`, `'57014'`, `'40001'`, or `NULL` when not a PostgreSQL engine error)
- `last_http_status`: Integer (`NULLABLE`, `CHECK (last_http_status IS NULL OR (last_http_status >= 100 AND last_http_status <= 599))` — external HTTP status code only, or `NULL` when no external HTTP response was involved)
- `last_error_code`: String (`NULLABLE` — canonical application error slug only: `'DB_DEADLOCK'`, `'DB_LOCK_TIMEOUT'`, `'DB_QUERY_TIMEOUT'`, `'DB_SERIALIZATION_FAILURE'`, `'DB_TRANSIENT_UNAVAILABLE'`, `'PROCESSING_LEASE_EXPIRED'`, `'MAX_RETRIES_EXHAUSTED'`, `'INSUFFICIENT_STOCK'`, `'VALIDATION_ERROR'`, `'RESOURCE_NOT_FOUND'`, `'VARIANT_PARENT_NOT_SELLABLE'`)
- `last_error_message`: Text (`NULLABLE` — sanitized human-readable message, never containing secrets, credentials, headers, or sensitive payload fields)
- `order_id`: UUID (`NULLABLE` — populated **only** when `status = 'SUCCEEDED'`)
- `payload`: JSONB (`NOT NULL` — original inbound webhook payload)
- `last_attempted_at`: Timestamp (`NULLABLE`)
- `completed_at`: Timestamp (`NULLABLE` — populated **only** when `status = 'SUCCEEDED'`)
- `created_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- `updated_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- *PostgreSQL Constraints & Indexes (`A9`, `F7-1`..`F7-6`)*:
  - `UNIQUE (tenant_id, id)` (referenced by composite FK from `sync_attempts`)
  - **Tenant-Scoped Idempotency Key**: `UNIQUE (tenant_id, source, external_id)`
  - `CHECK (attempt_count >= 0 AND attempt_count <= max_attempts)`
  - `CHECK (max_attempts = 5)`
  - `CHECK (last_http_status IS NULL OR (last_http_status >= 100 AND last_http_status <= 599))`
  - **Retry Scheduling State Invariant**:
    ```sql
    CHECK (
      (status = 'RETRY_SCHEDULED' AND next_retry_at IS NOT NULL AND next_trigger_source IS NOT NULL AND attempt_count >= 1 AND attempt_count < max_attempts)
      OR (status <> 'RETRY_SCHEDULED' AND next_retry_at IS NULL AND next_trigger_source IS NULL)
    )
    ```
  - **Processing Lease State Invariant**:
    ```sql
    CHECK (
      (status = 'PROCESSING' AND processing_started_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_token IS NOT NULL AND active_trigger_source IS NOT NULL AND attempt_count >= 1)
      OR (status <> 'PROCESSING' AND processing_started_at IS NULL AND lease_expires_at IS NULL AND lease_token IS NULL AND active_trigger_source IS NULL)
    )
    ```
  - **Succeeded State Invariant**:
    ```sql
    CHECK (
      (status = 'SUCCEEDED' AND order_id IS NOT NULL AND completed_at IS NOT NULL)
      OR (status <> 'SUCCEEDED' AND order_id IS NULL AND completed_at IS NULL)
    )
    ```
  - Composite FK: `(tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE RESTRICT`
  - Partial index for worker claiming (`PENDING` and due `RETRY_SCHEDULED`):
    ```sql
    CREATE INDEX idx_sync_logs_claimable
      ON sync_logs (tenant_id, status, next_retry_at ASC, created_at ASC, id ASC)
      WHERE status IN ('PENDING', 'RETRY_SCHEDULED');
    ```
  - Partial index for expired processing lease recovery:
    ```sql
    CREATE INDEX idx_sync_logs_lease_expired
      ON sync_logs (tenant_id, lease_expires_at ASC, id ASC)
      WHERE status = 'PROCESSING';
    ```
  - Index for tenant log listing: `CREATE INDEX idx_sync_logs_tenant_status ON sync_logs (tenant_id, status, created_at DESC, id DESC);`

### SyncAttempt (Tenant-Owned, Append-Only Synchronization Attempt History — `sync_attempts`)
- `id`: UUID (Primary Key — individual attempt identifier)
- `tenant_id`: UUID (Foreign Key -> `Tenant.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `sync_log_id`: UUID (Foreign Key -> `SyncLog.id` `ON DELETE RESTRICT`, `NOT NULL`)
- `attempt_number`: Integer (`NOT NULL`, `CHECK (attempt_number >= 1 AND attempt_number <= 5)` — equals `SyncLog.attempt_count` at the time the attempt was claimed in Phase A)
- `lease_token`: UUID (`NOT NULL` — matches the `SyncLog.lease_token` issued in Phase A Claim TX, preventing duplicate attempt insertion if a crashed worker and lease-recovery worker race)
- `trigger_source`: Enum (`WEBHOOK`, `AUTO_RETRY`, `MANUAL_RETRY`) (`NOT NULL`)
- `status`: Enum (`SUCCEEDED`, `FAILED_RETRYABLE`, `FAILED_PERMANENT`) (`NOT NULL`)
- `pg_sqlstate`: String (`VARCHAR(5)`, `NULLABLE` — 5-character PostgreSQL SQLSTATE code only, e.g., `'40P01'`, `'55P03'`, `'57014'`, `'40001'`, or `NULL`)
- `http_status`: Integer (`NULLABLE`, `CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599))` — external HTTP status code only, or `NULL`)
- `error_code`: String (`NULLABLE` — canonical application error slug only, e.g., `'DB_LOCK_TIMEOUT'`, `'PROCESSING_LEASE_EXPIRED'`, `'INSUFFICIENT_STOCK'`, or `NULL` when `status = 'SUCCEEDED'`)
- `error_message`: Text (`NULLABLE` — sanitized error description, or `NULL` when `status = 'SUCCEEDED'`)
- `started_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- `finished_at`: Timestamp (`NOT NULL`, Default: `CURRENT_TIMESTAMP`)
- `duration_ms`: Integer (`NOT NULL`, `CHECK (duration_ms >= 0)`)
- *PostgreSQL Constraints & Append-Only Enforcement (`A9`, `F7-4`, `F7-5`)*:
  - `CHECK (attempt_number >= 1 AND attempt_number <= 5)`
  - `CHECK (duration_ms >= 0)`
  - `CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599))`
  - `CHECK ((status = 'SUCCEEDED' AND error_code IS NULL AND error_message IS NULL AND pg_sqlstate IS NULL AND http_status IS NULL) OR (status <> 'SUCCEEDED' AND error_code IS NOT NULL))`
  - `UNIQUE (tenant_id, sync_log_id, attempt_number)`
  - `UNIQUE (tenant_id, sync_log_id, lease_token)`
  - Composite FK: `(tenant_id, sync_log_id) REFERENCES sync_logs(tenant_id, id) ON DELETE RESTRICT`
  - **Database-Level Immutability**: Enforced authoritatively at the PostgreSQL layer via a `BEFORE UPDATE OR DELETE` trigger (`prevent_sync_attempt_mutation()`) that raises an exception on any `UPDATE` or `DELETE`, combined with granting only `SELECT, INSERT` on `sync_attempts` to `omnistock_app` (`UPDATE, DELETE, TRUNCATE` revoked).
