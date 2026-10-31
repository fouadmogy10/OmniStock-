# API Contracts: OmniStock MVP

All authenticated user-facing endpoints require `Authorization: Bearer <JWT>` and are automatically scoped to the authenticated user's server-side `tenant_id` via `TenantInterceptor` and PostgreSQL Row-Level Security (`SET LOCAL app.current_tenant_id = '<tenant_uuid>'`). Any client-supplied `tenant_id` in headers, query parameters, or body payloads is ignored/rejected.

---

## 0. Authentication, Tenant Onboarding, User Management, Audit Logs & Explicit RBAC (`F8`, `F10-1`..`F10-3`, `A5-1`)

### Security & Authorization Gate (Deny-by-Default)
Every protected user-facing endpoint enforces a three-step server-side security gate before executing controller logic:
1. **Authentication (`JwtAuthGuard`)**: Missing, malformed, or expired JWTs are rejected with `401 Unauthorized` (`AUTH_UNAUTHORIZED`) and recorded via `public.record_pre_auth_audit_log('AUTH_TOKEN_INVALID', ...)`.
2. **Independent Tenant-Membership & DB-Backed Role Resolution (`TenantInterceptor`, `F10-3`)**: Extracts `tenant_id` and `user_id` (`sub`) strictly from the verified JWT, executes `SET LOCAL app.current_tenant_id = '<tenant_uuid>'` inside the active transaction, and queries the `User` row (`SELECT id, tenant_id, email, role, is_active FROM users WHERE id = :userId`) from the database. If `tenant_id` is missing, the `User` row does not exist in the active tenant, or `User.is_active == false`, the request is rejected with `403 Forbidden` (`TENANT_MEMBERSHIP_REQUIRED`) and logged in `AuditLog` (`CROSS_TENANT_ACCESS_DENIED`). Tenant membership is verified independently of permission checks, and the database-loaded `User.role` is attached to the request context as the sole authoritative role source.
3. **Explicit Permission Enforcement (`PermissionsGuard` + `@RequirePermissions('<module>:<action>')`, `F10-2`, `F10-3`)**: `PermissionsGuard` is the **sole authoritative RBAC guard** across the application (no coarse `RolesGuard` is used on routes). It evaluates the database-loaded `User.role` (`ADMIN`, `MANAGER`, `VIEWER`) against the explicit 29-permission matrix defined in `spec.md` `FR-002` (never trusting role claims inside the JWT, so role demotions or user deactivations via `PATCH /users/{id}` take effect on the very next request). If an endpoint lacks `@RequirePermissions(...)` metadata or the user's current database role does not grant the required permission, access is denied by default with `403 Forbidden` (`INSUFFICIENT_PERMISSIONS`).

### Narrow Exemption for Non-JWT Endpoints (`F10-1`, `FR-022`)
Only five endpoints are exempt from `JwtAuthGuard` and `PermissionsGuard`:
- `POST /tenants` (public tenant onboarding, rate-limited by client IP).
- `POST /auth/login` (public user login, rate-limited by composite `client_ip + tenant_slug + email` and coarse per-IP ceiling).
- `POST /sync/webhook/{source}` (machine-to-machine inbound channel webhook protected by `WebhookSignatureGuard`, which verifies `X-Sync-Tenant-Slug`, `X-Sync-External-Id`, `X-Sync-Timestamp` within `±300s`, and HMAC-SHA256 `X-Sync-Signature` against the active `SyncWebhookCredential` in `sync_webhook_credentials` after setting `SET LOCAL app.current_tenant_id`, and protected by two-tier pre-auth IP/source+IP and post-HMAC verified `tenant_id + source` rate limiting).
- `GET /health/live` (read-only liveness probe with zero database dependency).
- `GET /health/ready` (read-only readiness probe executing `SELECT 1` on `omnistock_app` without querying any tenant-owned table or setting tenant context).

### Cross-Cutting API Conventions (`FR-020`, `FR-021`)
- **API Routing & OpenAPI (`/api/docs`)**:
  - MVP v1 endpoints are served at the exact root paths documented in this file.
  - OpenAPI 3.0 documentation (`version: "1.0.0"`) is generated at `/api/docs` (`T034`), declaring the `bearer` JWT security scheme, required webhook signature headers (`X-Sync-Tenant-Slug`, `X-Sync-External-Id`, `X-Sync-Timestamp`, `X-Sync-Signature`), and standard error/pagination schemas.
- **Correlation ID Header (`X-Request-Id`)**:
  - Every HTTP request accepts an optional `X-Request-Id` header matching `^[A-Za-z0-9._-]{1,64}$`; if absent or invalid, the server generates a fresh UUIDv4.
  - The resolved `request_id` is echoed in the `X-Request-Id` response header, bound to structured JSON logs (alongside `tenant_id` and `user_id` populated strictly from authenticated/verified server-side context, never from client headers/payloads), and returned in all error envelopes.
- **Strict Request Validation (`ValidationPipe`)**:
  - Global `ValidationPipe` (`T008`) enforces `whitelist: true`, `forbidNonWhitelisted: true`, and `transform: true`.
  - Any unknown property — including any client-supplied `tenant_id` in a request body — or invalid type/UUID/constraint is rejected with `400 Bad Request` (`VALIDATION_ERROR`).
- **Canonical Error Response Envelope (`ApiExceptionFilter`)**:
  - Every `4xx` and `5xx` error response returns:
    ```json
    {
      "statusCode": 400,
      "error_code": "VALIDATION_ERROR",
      "message": "Human-readable error summary",
      "details": {},
      "request_id": "550e8400-e29b-41d4-a716-446655440000",
      "timestamp": "2026-10-30T19:00:00.000Z"
    }
    ```
  - `details` is optional. Unhandled `500` errors return `"error_code": "INTERNAL_SERVER_ERROR"` and `"message": "Internal server error"` with stack traces and raw SQL diagnostics suppressed.
- **Standard Pagination Convention**:
  - All 10 paginated `GET` list endpoints (`GET /users`, `GET /audit-logs`, `GET /customers`, `GET /products`, `GET /inventory/levels`, `GET /inventory/movements`, `GET /alerts/low-stock`, `GET /transfers`, `GET /orders`, `GET /sync/logs`) enforce `page` (default `1`, integer `>= 1`) and `limit` (default `20`, integer `1..100`; returning `400 Bad Request` `VALIDATION_ERROR` if `< 1` or `> 100`) and return `{ "data": T[], "page": number, "limit": number, "total": number }`.
  - `GET /categories`, `GET /warehouses`, and `GET /sync/credentials` return unpaginated list responses as specified on their endpoint contracts.
- **Trusted Client IP Resolution, Rate Limiting & Two-Tier Webhook Throttling (`429 Too Many Requests` / `RATE_LIMIT_EXCEEDED`)**:
  - **Trusted Client IP (`client_ip`) Resolution Policy**: Rate limiting NEVER trusts arbitrary client-supplied `X-Forwarded-For` headers. Forwarding headers (`X-Forwarded-For`) are honored **only** when the immediate connecting socket peer (`req.socket.remoteAddress`) matches an explicitly configured trusted proxy in `TRUSTED_PROXY_IPS` (default empty/disabled so no proxy is trusted by default). When the immediate peer is **not** a configured trusted proxy, `X-Forwarded-For` is ignored completely and `req.socket.remoteAddress` is used as `client_ip`. When the immediate peer **is** an explicitly configured trusted proxy, `client_ip` is resolved via a right-to-left trusted-proxy chain policy — inspecting `X-Forwarded-For` from rightmost to leftmost and selecting the first address not in `TRUSTED_PROXY_IPS` (falling back to `req.socket.remoteAddress` if absent or malformed) — preventing clients from spoofing or bypassing rate limits via forged `X-Forwarded-For` headers. This exact `client_ip` policy applies consistently to all IP-based rate limits below (`POST /tenants`, `POST /auth/login`, and both pre-authentication webhook buckets).
  - **Rate-Limit Buckets (`RATE_LIMIT_TTL_SECONDS`, default `60` seconds)**: Exceeding an endpoint's rate limit returns `429 Too Many Requests` with `error_code: "RATE_LIMIT_EXCEEDED"` and a `Retry-After: <seconds>` header:
    1. `POST /tenants`: Keyed by resolved `client_ip` (`tenant_onboard:ip:${client_ip}`, default `RATE_LIMIT_TENANT_ONBOARD_MAX = 5` per 60s).
    2. `POST /auth/login`: Keyed by resolved `client_ip` (`login:account:${client_ip}:${lower(tenant_slug)}:${lower(email)}`, default `RATE_LIMIT_LOGIN_MAX = 10` per 60s) plus a coarse per-IP ceiling `login:ip:${client_ip}` (default `RATE_LIMIT_LOGIN_IP_MAX = 30` per 60s).
    3. `POST /sync/webhook/{source}` (**Two-Tier Rate Limiting**):
       - **Tier 1 — Pre-Authentication (before `WebhookSignatureGuard` HMAC verification)**: Never trusts `X-Sync-Tenant-Slug` as an authenticated tenant identity before HMAC verification. Applies a per-IP limit (`webhook:preauth:ip:${client_ip}`, default `RATE_LIMIT_WEBHOOK_IP_MAX = 60` per 60s) and a per-source+IP limit (`webhook:preauth:source_ip:${lower(source)}:${client_ip}`, default `RATE_LIMIT_WEBHOOK_SOURCE_IP_MAX = 120` per 60s) using the trusted `client_ip` resolution policy.
       - **Tier 2 — Post-HMAC Verification (authenticated tenant quota)**: Applied only **after** `WebhookSignatureGuard` verifies the active `Tenant` and HMAC-SHA256 signature, keyed strictly by the verified `tenant_id` and normalized `source` (`webhook:tenant:${verified_tenant_id}:${lower(source)}`, default `RATE_LIMIT_WEBHOOK_TENANT_MAX = 120` per 60s).

---

### POST /tenants
Register a new tenant organization and its initial `ADMIN` user (public onboarding endpoint).
- **Authentication**: Public onboarding endpoint (rate-limited).
- **Request**:
  ```json
  {
    "name": "Acme Retail Group",
    "slug": "acme-retail",
    "admin_email": "admin@acme.example.com",
    "admin_password": "StrongPassword123!"
  }
  ```
- **Validation & Logic**:
  - `name`, `slug` (normalized lowercase, unique globally in `tenants`), `admin_email` (normalized lowercase), and `admin_password` are required.
  - Executes in an atomic transaction creating the `Tenant` record (`is_active: true`), setting `SET LOCAL app.current_tenant_id`, creating the initial `User` (`role: "ADMIN"`, `is_active: true`), and recording `ADMIN_ACTION` (`entity_type: "Tenant"`) in `AuditLog`.
- **Response**: `201 Created` + `{ "tenant": Tenant, "admin_user": User }`.

### POST /auth/login
Authenticate a tenant user and issue a tenant-scoped JWT.
- **Authentication**: Public endpoint.
- **Request**:
  ```json
  {
    "tenant_slug": "acme-retail",
    "email": "admin@acme.example.com",
    "password": "StrongPassword123!"
  }
  ```
- **Logic**:
  - If `tenant_slug` does not match an active tenant (`tenants.is_active = true`), records an unattributable pre-auth failure via `public.record_pre_auth_audit_log('AUTH_LOGIN_FAILURE', ...)` and returns `401 Unauthorized` (`AUTH_UNAUTHORIZED`).
  - If the tenant exists, sets `SET LOCAL app.current_tenant_id = '<tenant_uuid>'` and verifies user credentials and `User.is_active == true`. On failure (including inactive user), records `AUTH_LOGIN_FAILURE` in tenant-scoped `AuditLog` and returns `401 Unauthorized` (`AUTH_UNAUTHORIZED`).
  - On success, records `AUTH_LOGIN_SUCCESS` in `AuditLog` and returns a signed JWT containing `{ sub: user.id, tenant_id: tenant.id }` (plus informational `role: user.role`, while runtime authorization always re-queries `User.role` from `users`).
- **Response**: `200 OK` + `{ "access_token": "<JWT>", "user": { "id": "...", "tenant_id": "...", "email": "...", "role": "ADMIN" } }`.

### GET /tenants/me
Retrieve the current authenticated tenant's profile.
- **Required Permission**: `tenant:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Response**: `200 OK` + `Tenant` (`id`, `name`, `slug`, `is_active`, `created_at`).

### POST /users
Create a new user within the active tenant and assign a role (`ADMIN`, `MANAGER`, or `VIEWER`).
- **Required Permission**: `users:manage`
- **Authorized Roles**: `ADMIN` (`403 Forbidden` `INSUFFICIENT_PERMISSIONS` for `MANAGER` and `VIEWER`)
- **Request**:
  ```json
  {
    "email": "manager@acme.example.com",
    "password": "StrongPassword123!",
    "role": "MANAGER"
  }
  ```
- **Validation & Side Effects (`A5-1`)**:
  - `email` is normalized to lowercase and validated for uniqueness within the active tenant (`UNIQUE (tenant_id, lower(email))` -> `409 Conflict` on duplicate).
  - `role` must be one of `ADMIN`, `MANAGER`, `VIEWER` (`400 Bad Request` `VALIDATION_ERROR` otherwise; `SYSTEM_WORKER` is never assignable to user records or JWTs).
  - Records `USER_CREATED` in `AuditLog`.
- **Response**: `201 Created` + `User` (`id`, `tenant_id`, `email`, `role`, `is_active`, `created_at`, `updated_at`).

### GET /users
List users in the active tenant (paginated).
- **Required Permission**: `users:read`
- **Authorized Roles**: `ADMIN`
- **Query Params**: `role`, `is_active`, `page`, `limit`.
- **Response**: `200 OK` + paginated list of `User` (excluding `password_hash`).

### GET /users/{id}
Retrieve a single user in the active tenant by UUID.
- **Required Permission**: `users:read`
- **Authorized Roles**: `ADMIN`
- **Response**: `200 OK` + `User` (`404 Not Found` if absent or belongs to another tenant).

### PATCH /users/{id}
Update a tenant user's `role` or `is_active` status.
- **Required Permission**: `users:manage`
- **Authorized Roles**: `ADMIN`
- **Request**: `{ "role": "VIEWER", "is_active": true }`
- **Validation & Last-Active-Admin Protection (`F10-3`, `A5-1`)**:
  - `404 Not Found` if target user does not exist in the active tenant.
  - `role` (if supplied) must be one of `ADMIN`, `MANAGER`, `VIEWER` (`400 Bad Request` `VALIDATION_ERROR` otherwise).
  - **Transactional Last-Active-Admin Guard**: Executes inside a transaction that locks all active `ADMIN` rows (`role = 'ADMIN' AND is_active = true`) in the active tenant using `SELECT ... FOR UPDATE`. If the target user is currently an active `ADMIN`, and the update would set `role <> 'ADMIN'` or `is_active = false` while the count of active `ADMIN` users in the tenant is `1`, the request is rejected with `409 Conflict` (`LAST_ACTIVE_ADMIN_REQUIRED`).
  - Because `TenantInterceptor` and `PermissionsGuard` load `User.role` and `User.is_active` from the database on every request, demoting a user's role or setting `is_active: false` takes effect immediately on their next API call without waiting for JWT expiration.
- **Side Effects**: Updates `User` and records `USER_UPDATED` in `AuditLog`.
- **Response**: `200 OK` + Updated `User`.

### GET /audit-logs
List immutable tenant-scoped security and business audit logs (paginated).
- **Required Permission**: `audit:read`
- **Authorized Roles**: `ADMIN`
- **Query Params**: `action`, `entity_type`, `entity_id`, `actor_user_id`, `from` (ISO-8601 UTC), `to` (ISO-8601 UTC), `page`, `limit` (default `20`, max `100`).
- **Isolation Rule**: Enforced by `audit_logs_tenant_isolation` RLS policy; returns only rows matching the active `tenant_id` and never exposes `tenant_id IS NULL` pre-auth records.
- **Response**: `200 OK` + paginated list of `AuditLog`.

---

## 1. Customer Management (`F1`, `F10`)

### POST /customers
Create a tenant-scoped customer.
- **Required Permission**: `customers:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Request**:
  ```json
  {
    "name": "John Doe",
    "email": "john.doe@example.com",
    "phone": "+966500000001"
  }
  ```
- **Validation**:
  - `name` is required and non-empty.
  - `email` (optional, normalized to lowercase) and `phone` (optional) are validated for uniqueness within the active tenant (`409 Conflict` on duplicate within the same tenant; never enforced globally across tenants).
- **Response**: `201 Created` + `Customer` (`id`, `tenant_id`, `name`, `email`, `phone`, `created_at`, `updated_at`).

### GET /customers
List customers for the active tenant (paginated).
- **Required Permission**: `customers:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Query Params**: `search`, `email`, `phone`, `page`, `limit`.
- **Response**: `200 OK` + paginated list of `Customer`.

### GET /customers/{id}
Retrieve a single customer by UUID.
- **Required Permission**: `customers:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Response**: `200 OK` + `Customer` (`404 Not Found` if absent or belongs to another tenant).

### PATCH /customers/{id}
Update a customer's `name`, `email`, or `phone`.
- **Required Permission**: `customers:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Validation**: Tenant-scoped `email` and `phone` uniqueness (`409 Conflict` on duplicate within the active tenant; `404 Not Found` if customer does not exist in active tenant).
- **Side Effect**: Updates the `Customer` record; historical `customer_name_snapshot` and `customer_email_snapshot` values on existing orders remain unchanged.
- **Response**: `200 OK` + Updated `Customer`.

---

## 2. Product Catalog, Categories & Variants (`A1`, `A5-2`, `F10`)

### POST /categories
Create a flat tenant-scoped product category.
- **Required Permission**: `categories:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Request**: `{ "name": "Smartphones", "description": "Mobile devices and accessories" }`
- **Validation**: `name` required and unique per tenant (`409 Conflict` if duplicate case-insensitive name in tenant). Categories are flat (no nested `parent_id` in MVP).
- **Response**: `201 Created` + `Category`.

### GET /categories
List categories for the active tenant.
- **Required Permission**: `categories:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Response**: `200 OK` + list of `Category`.

### PATCH /categories/{id}
Update a category's `name` or `description`.
- **Required Permission**: `categories:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Request**: `{ "name": "Smartphones & Tablets", "description": "Updated description" }`
- **Validation**: Case-insensitive `name` uniqueness within the active tenant (`409 Conflict` on duplicate; `404 Not Found` if category does not exist in active tenant).
- **Response**: `200 OK` + Updated `Category`.

### POST /products
Create a standalone product SKU, a variant parent container, or a child variant SKU.
- **Required Permission**: `products:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Request**:
  ```json
  {
    "sku": "IPHONE-15-PRO-256-BLK",
    "barcode": "0194253939481",
    "name": "iPhone 15 Pro 256GB Black",
    "description": "Titanium Black 256GB variant",
    "category_id": "uuid-or-null",
    "parent_product_id": "uuid-or-null",
    "is_variant_parent": false,
    "variant_attributes": { "color": "Black", "storage": "256GB" },
    "price": 1099.00
  }
  ```
- **Validation**:
  - `sku` is required (`NOT NULL`) and unique per tenant (`UNIQUE (tenant_id, sku)` -> `409 Conflict`).
  - `barcode` is optional and unique per tenant when present (`UNIQUE (tenant_id, barcode) WHERE barcode IS NOT NULL` -> `409 Conflict`).
  - `price` is required (`NOT NULL`, `price >= 0` -> `400 Bad Request` `VALIDATION_ERROR` if `< 0`).
  - If `parent_product_id` is provided, it must reference an existing product in the same tenant with `is_variant_parent = true`, and the child row must have `is_variant_parent = false` (no multi-level variant nesting -> `400 Bad Request` `VALIDATION_ERROR`).
  - Variant parent container products (`is_variant_parent = true`) still have required `sku` and `price` fields, but are not sellable and cannot have inventory, transfer items, or order items; stock is tracked only on concrete sellable SKUs (`is_variant_parent = false`).
- **Response**: `201 Created` + `Product`.

### GET /products
List products/variants for the active tenant (paginated).
- **Required Permission**: `products:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Query Params**: `sku`, `barcode`, `category_id`, `parent_product_id`, `is_variant_parent`, `is_active`, `page`, `limit`.
- **Response**: `200 OK` + paginated list of `Product`.

### GET /products/{id}
Retrieve a product by UUID (includes child `variants` array when `is_variant_parent = true`).
- **Required Permission**: `products:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Response**: `200 OK` + `Product` (`404 Not Found` if absent or belongs to another tenant).

### PATCH /products/{id}
Update product metadata (`name`, `description`, `barcode`, `category_id`, `variant_attributes`, `price`, `is_active`).
- **Required Permission**: `products:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Validation (`A5-2`)**:
  - `404 Not Found` if the product does not exist in the active tenant.
  - If `price` is provided, `price >= 0` is required (`400 Bad Request` `VALIDATION_ERROR` if `price < 0` or `null`).
  - If `barcode` is provided and non-null, validates tenant-scoped uniqueness (`UNIQUE (tenant_id, barcode) WHERE barcode IS NOT NULL` -> `409 Conflict` if already assigned to another product in the same tenant). Setting `barcode: null` is permitted.
  - If `category_id` is provided and non-null, it must reference a category belonging to the active tenant (`404 Not Found` otherwise).
  - Structural variant hierarchy fields (`is_variant_parent`, `parent_product_id`) cannot be mutated in a way that violates single-level variant hierarchy (`NOT (is_variant_parent = true AND parent_product_id IS NOT NULL)`), converts a sellable SKU with existing `InventoryItem`/`OrderItem`/`StockTransferItem` records into a variant parent, or attaches a child variant to a non-parent product (`400 Bad Request` `VALIDATION_ERROR` / `409 Conflict`).
- **Response**: `200 OK` + Updated `Product`.

---

## 3. Warehouses, Inventory Levels, Low-Stock Alerts & Stock Transfers (`F2-1`, `F2-2`, `F10`, `A2`, `A3`, `A5-3`)

### POST /warehouses
Create a tenant warehouse with explicit allocation priority.
- **Required Permission**: `warehouses:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Request**: `{ "name": "Riyadh Primary Hub", "location": "Riyadh", "priority": 1, "is_active": true }`
- **Validation**: `priority >= 1` (lower integer = higher priority during automatic order allocation); `name` unique per tenant (`UNIQUE (tenant_id, lower(name))` -> `409 Conflict` on duplicate).
- **Response**: `201 Created` + `Warehouse`.

### GET /warehouses
List tenant warehouses ordered by `priority ASC, created_at ASC, id ASC`.
- **Required Permission**: `warehouses:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Response**: `200 OK` + list of `Warehouse`.

### PATCH /warehouses/{id}
Update a warehouse's `name`, `location`, `priority`, or `is_active` status.
- **Required Permission**: `warehouses:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Request**: `{ "name": "Riyadh Main Hub", "priority": 2, "is_active": true }`
- **Validation & Deactivation Guard (`A5-3`)**:
  - `404 Not Found` if warehouse does not belong to the active tenant.
  - If `priority` is provided, `priority >= 1` (`400 Bad Request` `VALIDATION_ERROR` if `< 1`).
  - If `name` is provided, validates case-insensitive uniqueness within the active tenant (`UNIQUE (tenant_id, lower(name))` -> `409 Conflict` on duplicate name in the same tenant).
  - **Active Stock Commitment Guard on Deactivation (`is_active: false`)**: If `is_active: false` is requested, executes inside a transaction that locks all `InventoryItem` rows for `(tenant_id, warehouse_id)` using `SELECT ... FOR UPDATE` in `(product_id ASC, warehouse_id ASC)` order and verifies that zero rows have `reserved > 0` or `in_transit > 0`. If any `InventoryItem` in the warehouse has `reserved > 0` (active allocated order reservations) or `in_transit > 0` (inbound dispatched stock transfers), the update is rejected with `409 Conflict` (`WAREHOUSE_HAS_ACTIVE_STOCK_COMMITMENTS`).
- **Response**: `200 OK` + Updated `Warehouse`.

### POST /inventory/adjust
Adjust physical (`on_hand`) stock levels manually.
- **Required Permission**: `inventory:adjust`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Request**:
  ```json
  {
    "product_id": "uuid-product",
    "warehouse_id": "uuid-warehouse",
    "delta": 10,
    "reason": "Restock"
  }
  ```
- **Validation & Logic**:
  - Target `product_id` must reference a sellable SKU (`is_variant_parent = false`); parent container products are rejected (`400 Bad Request` `VARIANT_PARENT_NOT_SELLABLE`).
  - Executes inside a database transaction with `SELECT FOR UPDATE` on `InventoryItem` in global deterministic `(product_id ASC, warehouse_id ASC)` order.
  - Rejects adjustments where `delta == 0` (`400 Bad Request`) or where resulting `on_hand < reserved` or `on_hand < 0` (`409 Conflict`).
  - Evaluates `LowStockAlert` state on the updated `InventoryItem`:
    - If `low_stock_threshold IS NOT NULL AND available <= low_stock_threshold`, creates a new `OPEN` `LowStockAlert` (logging `LOW_STOCK_ALERT_TRIGGERED` in `AuditLog`) or updates `current_available` on the existing `OPEN` alert for `(tenant_id, inventory_item_id)`.
    - If an `OPEN` alert exists and `available > low_stock_threshold`, transitions the alert to `status = "RESOLVED"` (`resolved_at = CURRENT_TIMESTAMP`, logging `LOW_STOCK_ALERT_RESOLVED` in `AuditLog`).
- **Response**: `200 OK` + Updated `InventoryItem` (`id`, `product_id`, `warehouse_id`, `on_hand`, `reserved`, `available`, `in_transit`, `low_stock_threshold`).
- **Side Effects**: Creates immutable `StockMovement` (`type: ADJUSTMENT`, `delta`), evaluates `LowStockAlert`, and records `AuditLog` (`action: INVENTORY_ADJUSTED`).

### PATCH /inventory/items/{id}/threshold
Configure or disable the per-warehouse-SKU low-stock threshold (`low_stock_threshold`) on an `InventoryItem`.
- **Required Permission**: `inventory:threshold`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Request**:
  ```json
  {
    "low_stock_threshold": 5
  }
  ```
- **Validation & Logic (Atomic Transaction with `SELECT FOR UPDATE`)**:
  - `low_stock_threshold` must be either `null` (disables low-stock alerting for this warehouse SKU) or an integer `>= 0` (`400 Bad Request` `VALIDATION_ERROR` if `< 0`).
  - Locks the `InventoryItem` row (`SELECT ... FOR UPDATE`), updates `low_stock_threshold`, and immediately evaluates alert state against current `available` (`on_hand - reserved`):
    - If `low_stock_threshold IS NOT NULL AND available <= low_stock_threshold`: creates an `OPEN` `LowStockAlert` (or updates `threshold` and `current_available` on the existing `OPEN` alert) and logs `LOW_STOCK_ALERT_TRIGGERED` if newly opened.
    - If an `OPEN` alert exists and (`low_stock_threshold IS NULL` or `available > low_stock_threshold`): transitions the `OPEN` alert to `status = "RESOLVED"` (`resolved_at = CURRENT_TIMESTAMP`) and logs `LOW_STOCK_ALERT_RESOLVED`.
  - Records `LOW_STOCK_THRESHOLD_UPDATED` in `AuditLog`.
- **Response**: `200 OK` + Updated `InventoryItem` (`id`, `product_id`, `warehouse_id`, `on_hand`, `reserved`, `available`, `in_transit`, `low_stock_threshold`).

### GET /inventory/levels
List stock levels across warehouses.
- **Required Permission**: `inventory:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Query Params**: `sku`, `product_id`, `warehouse_id`, `low_stock_only` (boolean), `page`, `limit`.
- **Response**: `200 OK` + paginated list of `InventoryItem` with `on_hand`, `reserved`, `available` (`on_hand - reserved`), `in_transit` (excluded from `on_hand` and `available`), and `low_stock_threshold`.

### GET /inventory/movements
List immutable `StockMovement` ledger entries for the active tenant (paginated).
- **Required Permission**: `movements:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Query Params**: `product_id`, `warehouse_id`, `type` (`ADJUSTMENT | SALE | TRANSFER | RETURN` — note that `RETURN` is a reserved enum value in MVP; no public endpoint creates `RETURN` movements in MVP, so filtering by `type=RETURN` returns an empty list `data: []`; `F2-2`), `reference_id`, `from` (ISO-8601 UTC), `to` (ISO-8601 UTC), `page`, `limit` (default `20`, max `100`).
- **Ordering**: `created_at DESC, id DESC`.
- **Response**: `200 OK` + paginated list of `StockMovement` (`id`, `tenant_id`, `product_id`, `warehouse_id`, `delta`, `type`, `reference_id`, `created_at`).

### GET /alerts/low-stock
List per-warehouse-SKU low-stock alerts (`LowStockAlert`) for the active tenant (paginated).
- **Required Permission**: `alerts:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Query Params**: `status` (`OPEN | RESOLVED`, defaults to all when omitted), `warehouse_id`, `product_id`, `page`, `limit`.
- **Ordering**: `triggered_at DESC, id DESC`.
- **Response**: `200 OK` + paginated list of `LowStockAlert`:
  ```json
  {
    "data": [
      {
        "id": "uuid-alert",
        "tenant_id": "uuid-tenant",
        "inventory_item_id": "uuid-inv-item",
        "product_id": "uuid-product",
        "warehouse_id": "uuid-warehouse",
        "threshold": 5,
        "current_available": 2,
        "status": "OPEN",
        "triggered_at": "2026-10-30T18:00:00.000Z",
        "resolved_at": null,
        "updated_at": "2026-10-30T18:05:00.000Z"
      }
    ],
    "page": 1,
    "limit": 20,
    "total": 1
  }
  ```

### GET /alerts/low-stock/{id}
Retrieve a single `LowStockAlert` by UUID.
- **Required Permission**: `alerts:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Response**: `200 OK` + `LowStockAlert` (`404 Not Found` if absent or belongs to another tenant).

### POST /transfers
Create a `DRAFT` inter-warehouse stock transfer.
- **Required Permission**: `transfers:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Request**:
  ```json
  {
    "source_warehouse_id": "uuid-warehouse-a",
    "destination_warehouse_id": "uuid-warehouse-b",
    "notes": "Replenish secondary hub",
    "items": [
      { "product_id": "uuid-product", "quantity": 4 }
    ]
  }
  ```
- **Validation**:
  - `source_warehouse_id <> destination_warehouse_id` (`400 Bad Request` if identical).
  - Both warehouses must belong to the active tenant (`404 Not Found` otherwise) and be active.
  - Each item in `items` must reference a sellable SKU (`product_id` with `is_variant_parent = false`) and `quantity > 0`.
- **Response**: `201 Created` + `StockTransfer` (`status: "DRAFT"`).

### POST /transfers/{id}/dispatch
Dispatch a `DRAFT` transfer (`DRAFT -> IN_TRANSIT`).
- **Required Permission**: `transfers:execute`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Logic (Atomic Transaction with `SELECT FOR UPDATE`)**:
  1. Lock the `StockTransfer` header row (`SELECT ... FOR UPDATE`) and verify `StockTransfer.status == "DRAFT"` (`409 Conflict` `INVALID_TRANSFER_TRANSITION` otherwise, preventing concurrent duplicate dispatches).
  2. Lock source and destination `InventoryItem` rows in global deterministic `(product_id ASC, warehouse_id ASC)` order.
  3. Verify source `available >= quantity` for every transfer item; if any item has insufficient stock, roll back the entire transaction and return `409 Conflict` (`INSUFFICIENT_STOCK`).
  4. Decrement source `InventoryItem.on_hand -= quantity`, insert source `StockMovement` (`type: TRANSFER`, `delta: -quantity`, `reference_id: transfer.id`), and evaluate `LowStockAlert` state on each source `InventoryItem`.
  5. Increment destination `InventoryItem.in_transit += quantity` (never counted in `on_hand` or `available` in either warehouse).
  6. Set `StockTransfer.status = "IN_TRANSIT"`, `dispatched_at = CURRENT_TIMESTAMP`, and record `STOCK_TRANSFER_DISPATCHED` in `AuditLog`.
- **Response**: `200 OK` + Updated `StockTransfer` (`status: "IN_TRANSIT"`).

### POST /transfers/{id}/receive
Confirm full receipt of an `IN_TRANSIT` transfer at the destination warehouse (`IN_TRANSIT -> RECEIVED`).
- **Required Permission**: `transfers:execute`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Logic (Atomic Transaction with `SELECT FOR UPDATE`)**:
  1. **Full-Only Receipt Rule**: Partial transfer receipt is NOT supported in MVP; `POST /transfers/{id}/receive` receives the full dispatched `quantity` for every `StockTransferItem` (receipt cannot exceed dispatched quantities).
  2. Lock the `StockTransfer` header row (`SELECT ... FOR UPDATE`) and verify `StockTransfer.status == "IN_TRANSIT"` (`409 Conflict` `INVALID_TRANSFER_TRANSITION` otherwise, preventing repeated or concurrent receipt requests from applying stock changes twice).
  3. Lock destination `InventoryItem` rows in global deterministic `(product_id ASC, warehouse_id ASC)` order, decrement `in_transit -= quantity`, increment `on_hand += quantity`, insert destination `StockMovement` (`type: TRANSFER`, `delta: +quantity`, `reference_id: transfer.id`), and evaluate `LowStockAlert` resolution on each destination `InventoryItem`.
  4. Set `StockTransfer.status = "RECEIVED"`, `received_at = CURRENT_TIMESTAMP`, and record `STOCK_TRANSFER_RECEIVED` in `AuditLog`.
- **Response**: `200 OK` + Updated `StockTransfer` (`status: "RECEIVED"`).

### POST /transfers/{id}/cancel
Cancel a `DRAFT` transfer (`DRAFT -> CANCELLED`).
- **Required Permission**: `transfers:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Logic (Atomic Transaction with `SELECT FOR UPDATE`)**:
  1. Lock the `StockTransfer` header row (`SELECT ... FOR UPDATE`) and verify `StockTransfer.status == "DRAFT"`. Rejects `IN_TRANSIT`, `RECEIVED`, or `CANCELLED` transfers with `409 Conflict` (`INVALID_TRANSFER_TRANSITION`).
  2. Set `StockTransfer.status = "CANCELLED"`, `cancelled_at = CURRENT_TIMESTAMP`, and record `STOCK_TRANSFER_CANCELLED` in `AuditLog`.
- **Response**: `200 OK` + Updated `StockTransfer` (`status: "CANCELLED"`).

### GET /transfers
List inter-warehouse stock transfers for the active tenant (paginated).
- **Required Permission**: `transfers:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Query Params**: `status` (`DRAFT | IN_TRANSIT | RECEIVED | CANCELLED`), `source_warehouse_id`, `destination_warehouse_id`, `page`, `limit`.
- **Response**: `200 OK` + paginated list of `StockTransfer`.

### GET /transfers/{id}
Retrieve a stock transfer with its items and status timestamps.
- **Required Permission**: `transfers:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Response**: `200 OK` + `StockTransfer` (`404 Not Found` if absent or belongs to another tenant).

---

## 4. Order Lifecycle & Split Allocation (`F6`, `F10`, `A3`, `A5`, `A7`, `A8`, `A11`)

> **Deprecation Note**: Single-warehouse fields `OrderItem.allocated_warehouse_id` and top-level `Order.allocated_warehouse_id` are removed. Warehouse allocations are represented exclusively via `items[].allocations` (`OrderAllocation` records).

### POST /orders
Create a new order (either as an editable `DRAFT` or with immediate atomic allocation).
- **Required Permission**: `orders:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Request**:
  ```json
  {
    "customer_id": "uuid-customer",
    "auto_allocate": true,
    "items": [
      { "product_id": "uuid-product", "quantity": 12 }
    ]
  }
  ```
- **Logic**:
  1. Validate `customer_id` belongs to the active tenant and capture `customer_name_snapshot` and `customer_email_snapshot` from `Customer`.
  2. Validate all items in `items` reference sellable SKUs (`product_id` with `is_variant_parent = false`) and `quantity > 0`.
  3. **If `auto_allocate: false`**: Persist `Order` (`status: "DRAFT"`) and `OrderItem` rows with empty `allocations: []` and zero stock reservations. Return `201 Created`.
  4. **If `auto_allocate: true` (default)**: Execute `DRAFT -> PENDING -> ALLOCATED` inside a single atomic transaction:
     - Identify all candidate `InventoryItem` rows across active warehouses (`Warehouse.is_active = true`) and lock them (`SELECT ... FOR UPDATE`) in global deterministic `(product_id ASC, warehouse_id ASC)` order.
     - After acquiring locks, evaluate warehouse allocation preference in memory using `(Warehouse.priority ASC, Warehouse.created_at ASC, Warehouse.id ASC)`.
     - Allocate each item across one or more priority-ordered warehouses (`OrderAllocation` rows), increment `InventoryItem.reserved += allocated_quantity`, and evaluate `LowStockAlert` state on each affected `InventoryItem`.
     - **All-or-Nothing Insufficient-Stock Rule**: If the full requested quantity for *any* item cannot be allocated across active warehouses, **roll back the entire transaction (`ROLLBACK`)**, persist zero orders and zero partial reservations, and return `409 Conflict` (`INSUFFICIENT_STOCK`). Never silently create a `PENDING` order when allocation fails.
- **Response (`201 Created` when `auto_allocate: true`)**:
  ```json
  {
    "id": "uuid-order",
    "customer_id": "uuid-customer",
    "customer_name_snapshot": "John Doe",
    "customer_email_snapshot": "john.doe@example.com",
    "status": "ALLOCATED",
    "total_amount": 13188.00,
    "items": [
      {
        "id": "uuid-order-item",
        "product_id": "uuid-product",
        "sku": "IPHONE-15-PRO-256-BLK",
        "quantity": 12,
        "unit_price": 1099.00,
        "allocations": [
          { "id": "uuid-alloc-1", "warehouse_id": "uuid-warehouse-a", "allocated_quantity": 5 },
          { "id": "uuid-alloc-2", "warehouse_id": "uuid-warehouse-b", "allocated_quantity": 7 }
        ]
      }
    ]
  }
  ```

### PATCH /orders/{id}
Update customer or line items on a `DRAFT` order.
- **Required Permission**: `orders:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Validation**: Locks the `Order` header row (`SELECT ... FOR UPDATE`) and verifies `Order.status == "DRAFT"` (`409 Conflict` / `INVALID_ORDER_TRANSITION` for any other state).
- **Response**: `200 OK` + Updated `Order`.

### POST /orders/{id}/submit
Submit a `DRAFT` order (`DRAFT -> PENDING`).
- **Required Permission**: `orders:write`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Logic**: Locks the `Order` header row (`SELECT ... FOR UPDATE`), validates the order is in `DRAFT` and has $\ge 1$ valid `OrderItem`, refreshes customer snapshots, and sets `status = "PENDING"` (no stock reserved yet). Rejects non-`DRAFT` orders with `409 Conflict` (`INVALID_ORDER_TRANSITION`).
- **Response**: `200 OK` + Updated `Order` (`status: "PENDING"`).

### POST /orders/{id}/allocate
Trigger all-or-nothing automatic warehouse allocation for a `DRAFT` or `PENDING` order (`DRAFT | PENDING -> ALLOCATED`).
- **Required Permission**: `orders:allocate`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Logic (Atomic Transaction with `SELECT FOR UPDATE`)**:
  1. Lock the `Order` header row (`SELECT ... FOR UPDATE`) and verify `Order.status IN ('DRAFT', 'PENDING')` (`409 Conflict` `INVALID_ORDER_TRANSITION` otherwise).
  2. Identify all candidate `InventoryItem` rows across active tenant warehouses and lock them (`SELECT ... FOR UPDATE`) in global deterministic `(product_id ASC, warehouse_id ASC)` order.
  3. After acquiring locks, evaluate warehouse allocation preference in memory using `(Warehouse.priority ASC, Warehouse.created_at ASC, Warehouse.id ASC)`; create `OrderAllocation` rows, increment `InventoryItem.reserved += allocated_quantity`, and evaluate `LowStockAlert` state on each affected `InventoryItem`.
  4. If complete allocation is impossible for any item, roll back all reservations/allocations, keep the order in its prior state, and return `409 Conflict` (`INSUFFICIENT_STOCK`).
- **Response**: `200 OK` + Updated `Order` (`status: "ALLOCATED"` with populated `items[].allocations`).

### POST /orders/{id}/ship
Confirm shipment of an `ALLOCATED` order (`ALLOCATED -> SHIPPED`).
- **Required Permission**: `orders:ship`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Logic (Atomic Transaction with `SELECT FOR UPDATE`)**:
  1. Lock the `Order` header row (`SELECT ... FOR UPDATE`) and verify `Order.status == "ALLOCATED"` (`409 Conflict` / `INVALID_ORDER_TRANSITION` from `DRAFT`, `PENDING`, `SHIPPED`, or `CANCELLED`, preventing concurrent duplicate shipments).
  2. Lock `InventoryItem` rows for all `OrderAllocation` records of the order in global deterministic `(product_id ASC, warehouse_id ASC)` order.
  3. Decrement `InventoryItem.on_hand -= allocated_quantity` and `InventoryItem.reserved -= allocated_quantity` for each `OrderAllocation` (`available = on_hand - reserved` remains unchanged).
  4. Insert an immutable `StockMovement` record (`type: SALE`, `delta: -allocated_quantity`, `reference_id: order.id`) for each `OrderAllocation`.
  5. Set `Order.status = "SHIPPED"`, `shipped_at = CURRENT_TIMESTAMP`, and record `ORDER_SHIPPED` in `AuditLog`.
- **Response**: `200 OK` + Updated `Order` (`status: "SHIPPED"`).

### POST /orders/{id}/cancel
Cancel an order and release reservations where applicable (`DRAFT | PENDING | ALLOCATED -> CANCELLED`).
- **Required Permission**: `orders:cancel`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Logic (Atomic Transaction with `SELECT FOR UPDATE`)**:
  1. Lock the `Order` header row (`SELECT ... FOR UPDATE`). If `Order.status IN ('SHIPPED', 'CANCELLED')`, reject with `409 Conflict` (`INVALID_ORDER_TRANSITION`).
  2. If `Order.status == "ALLOCATED"`, lock `InventoryItem` rows for all `OrderAllocation` records in global deterministic `(product_id ASC, warehouse_id ASC)` order, decrement `InventoryItem.reserved -= allocated_quantity` (restoring `available` stock; no `StockMovement` is created because `on_hand` did not change), and evaluate `LowStockAlert` resolution on each affected `InventoryItem`.
  3. Set `Order.status = "CANCELLED"`, `cancelled_at = CURRENT_TIMESTAMP`, and record `ORDER_CANCELLED` in `AuditLog`.
- **Response**: `200 OK` + Updated `Order` (`status: "CANCELLED"`).

### GET /orders
List orders for the active tenant (paginated).
- **Required Permission**: `orders:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Query Params**: `status` (`DRAFT | PENDING | ALLOCATED | SHIPPED | CANCELLED`), `customer_id`, `from` (ISO-8601 UTC), `to` (ISO-8601 UTC), `page`, `limit`.
- **Ordering**: `created_at DESC, id DESC`.
- **Response**: `200 OK` + paginated list of `Order`.

### GET /orders/{id}
Retrieve an order with customer snapshots, line items, and per-item `OrderAllocation` splits.
- **Required Permission**: `orders:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Response**: `200 OK` + `Order` (`404 Not Found` if absent or belongs to another tenant).

---

## 5. Operational Dashboard & Basic Reporting (`F3-1`..`F3-3`, `F10`, `A5`)

### GET /dashboard/summary
Retrieve deterministic tenant-scoped operational KPIs, order status breakdown, gross order value summary (`period_order_value`), active inventory quantity summary, active low-stock alert count, and bounded period-scoped recent activity.
- **Required Permission**: `dashboard:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`, `VIEWER`
- **Query Params & Date-Range Validation (`F3-2`)**:
  - `from` (optional ISO-8601 timestamp string with an explicit UTC offset `Z` or `±HH:MM`; defaults to `now() - 30 days` in UTC when omitted).
  - `to` (optional ISO-8601 timestamp string with an explicit UTC offset `Z` or `±HH:MM`; defaults to `now()` in UTC when omitted).
  - **Strict Timestamp Validation (`400 Bad Request` `VALIDATION_ERROR`)**: Both `from` and `to` (when provided) MUST include both time-of-day and an explicit timezone offset (`Z` or `±HH:MM`, normalized to UTC). Date-only strings (e.g., `2026-10-01`), timestamps without an explicit offset (e.g., `2026-10-01T00:00:00`), unparseable timestamps, or ranges where `from > to` are rejected with `400 Bad Request` (`VALIDATION_ERROR`).
  - **Inclusive UTC Boundaries (`[from, to]`)**: All period-bounded dashboard metrics (`orders_by_status`, `period_order_value`, `recent_orders`, and `recent_stock_movements`) evaluate `created_at >= from AND created_at <= to` in UTC.
  - `warehouse_id` (optional UUID; filters `inventory_quantity_summary`, `low_stock_alerts_count`, and `recent_stock_movements` to a specific tenant warehouse; `404 Not Found` if warehouse does not belong to active tenant).
  - `limit` (optional integer for `recent_orders` and `recent_stock_movements`; default `10`, min `1`, max `50`; `400 Bad Request` `VALIDATION_ERROR` if `< 1` or `> 50`).
- **Metric Calculation Rules (`F3-1`, `F3-2`, `F3-3`)**:
  - `total_products`: Count of active sellable SKUs (`products` where `is_variant_parent = false AND is_active = true`).
  - `total_variant_parents`: Count of active variant parent containers (`products` where `is_variant_parent = true AND is_active = true`).
  - `total_customers`: Count of `customers` in the active tenant.
  - `total_warehouses`: Count of active `warehouses` (`is_active = true`) in the active tenant.
  - `orders_by_status`: Exact counts of tenant `orders` with `created_at >= from AND created_at <= to` grouped by `DRAFT`, `PENDING`, `ALLOCATED`, `SHIPPED`, and `CANCELLED` (all 5 keys always present, defaulting to `0`).
  - `period_order_value` (`F3-1`): Sum of gross `Order.total_amount` (`SUM(OrderItem.quantity * OrderItem.unit_price)`) for tenant orders with `created_at >= from AND created_at <= to`, reported as:
    - `allocated_order_value`: `COALESCE(SUM(total_amount), 0.00)` where `status = 'ALLOCATED'`.
    - `shipped_order_value`: `COALESCE(SUM(total_amount), 0.00)` where `status = 'SHIPPED'`.
    - `combined_committed_order_value`: `COALESCE(SUM(total_amount), 0.00)` where `status IN ('ALLOCATED', 'SHIPPED')`.
    - `DRAFT`, `PENDING`, and `CANCELLED` orders are excluded. **Note**: These fields represent gross order value only (never collected payments, recognized accounting revenue, profit, or COGS).
  - `inventory_quantity_summary` (`F3-3`): Sum of `on_hand`, `reserved`, `available` (`on_hand - reserved`), and `in_transit` across `inventory_items` joined to `products` and `warehouses` where **`Product.is_active = true AND Product.is_variant_parent = false AND Warehouse.is_active = true`** (and additionally filtered by `warehouse_id` when supplied; if the supplied `warehouse_id` has `is_active = false`, totals return `0`). **Inventory cost/valuation is explicitly excluded** because `Product` models only selling `price` and does not track unit cost/COGS.
  - `low_stock_alerts_count` (`F3-3`): Count of currently `OPEN` `LowStockAlert` rows (`status = 'OPEN'`) joined to `products` and `warehouses` where **`Product.is_active = true AND Warehouse.is_active = true`** (and filtered by `warehouse_id` when supplied). Deactivating a product or warehouse never deletes, mutates, or resolves historical `LowStockAlert` rows.
  - `recent_orders` (`F3-2`): Top `limit` rows from `orders` within the inclusive UTC period `created_at >= from AND created_at <= to`, ordered by `created_at DESC, id DESC`.
  - `recent_stock_movements` (`F3-2`): Top `limit` rows from `stock_movements` within the inclusive UTC period `created_at >= from AND created_at <= to` (and filtered by `warehouse_id` when supplied), ordered by `created_at DESC, id DESC`.
- **Response (`200 OK`)**:
  ```json
  {
    "period": {
      "from": "2026-10-01T00:00:00.000Z",
      "to": "2026-10-30T23:59:59.999Z",
      "timezone": "UTC"
    },
    "warehouse_id": null,
    "catalog_and_network": {
      "total_products": 42,
      "total_variant_parents": 5,
      "total_customers": 120,
      "total_warehouses": 3
    },
    "orders_by_status": {
      "DRAFT": 2,
      "PENDING": 1,
      "ALLOCATED": 8,
      "SHIPPED": 25,
      "CANCELLED": 3
    },
    "period_order_value": {
      "allocated_order_value": 4200.00,
      "shipped_order_value": 18500.00,
      "combined_committed_order_value": 22700.00
    },
    "inventory_quantity_summary": {
      "total_on_hand": 1500,
      "total_reserved": 120,
      "total_available": 1380,
      "total_in_transit": 40
    },
    "low_stock_alerts_count": 3,
    "recent_orders": [
      {
        "id": "uuid-order",
        "customer_id": "uuid-customer",
        "customer_name_snapshot": "John Doe",
        "status": "ALLOCATED",
        "total_amount": 13188.00,
        "created_at": "2026-10-30T19:00:00.000Z"
      }
    ],
    "recent_stock_movements": [
      {
        "id": "uuid-movement",
        "product_id": "uuid-product",
        "warehouse_id": "uuid-warehouse-a",
        "delta": -5,
        "type": "SALE",
        "reference_id": "uuid-order",
        "created_at": "2026-10-30T19:05:00.000Z"
      }
    ]
  }
  ```

---

## 6. External Synchronization, Webhook Credentials, Retries & Failure Recovery (`F7-1`..`F7-6`, `F10-1`, `F7-CRYPTO-1`..`F7-CRYPTO-3`, `A5`, `A9`)

### POST /sync/credentials
Provision or rotate the active inbound webhook signing credential (`SyncWebhookCredential`) for an external channel `source` in the active tenant (`F10-1`, `F7-CRYPTO-1`..`F7-CRYPTO-3`).
- **Required Permission**: `sync:credentials`
- **Authorized Roles**: `ADMIN` (`403 Forbidden` `INSUFFICIENT_PERMISSIONS` for `MANAGER` and `VIEWER`)
- **Versioned Keyring Configuration (`F7-CRYPTO-1`)**:
  - `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION`: positive integer `>= 1` identifying the active key version for all new encryptions.
  - `WEBHOOK_SECRET_ENCRYPTION_KEYS`: comma-separated versioned keyring `<version>:<64-lowercase-hex-chars>,...` (e.g., `1:<64-hex-character-key>,2:<64-hex-character-key>`), never stored in PostgreSQL.
  - At application startup, every configured `hexKey` is explicitly validated against `/^[0-9a-f]{64}$/` **before** calling `Buffer.from(hexKey, 'hex')` into a 32-byte `Buffer` (`byteLength === 32` for AES-256-GCM) and verified to include `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION`; any `hexKey` failing `/^[0-9a-f]{64}$/`, duplicate/non-positive versions, decoded length `!== 32` bytes, or a missing current key version fails startup closed.
- **Request**:
  ```json
  {
    "source": "salla"
  }
  ```
- **Logic (Atomic Transaction)**:
  1. Normalize `source` to lowercase (`400 Bad Request` `VALIDATION_ERROR` if empty).
  2. Lock any existing active `SyncWebhookCredential` row for `(tenant_id, lower(source))` (`SELECT ... FOR UPDATE`). If an active row exists, atomically revoke it (`is_active = false`, `revoked_at = CURRENT_TIMESTAMP`) without deleting the row and record `SYNC_CREDENTIAL_REVOKED` in `AuditLog`.
  3. Generate 32 cryptographically secure random bytes (CSPRNG) and encode them as a 64-character lowercase hexadecimal string `webhook_secret` (`^[0-9a-f]{64}$`). Compute `secret_hash = SHA-256(UTF8(webhook_secret))` (64-character lowercase hexadecimal fingerprint/lookup value, never used as an HMAC key). Select `encryption_key_version = WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION` and its 32-byte key from `WEBHOOK_SECRET_ENCRYPTION_KEYS`. Generate a fresh 12-byte CSPRNG nonce (`encryption_iv`, 24-character lowercase hex) and encrypt the **64 UTF-8 bytes** of the hex string (`Buffer.from(webhook_secret, 'utf8')`, **not** the 32 raw random bytes) using AES-256-GCM with Additional Authenticated Data `AAD = UTF8("${tenant_id}:${lower(source)}:${encryption_key_version}")`, producing a 64-byte ciphertext encoded as a **128-character lowercase hexadecimal string** `encrypted_secret` (`CHECK (encrypted_secret ~ '^[0-9a-f]{128}$')`) and a 16-byte authentication tag (`encryption_auth_tag`, 32-character lowercase hex). Insert the new `SyncWebhookCredential` row (`secret_hash`, `encrypted_secret`, `encryption_iv`, `encryption_auth_tag`, `encryption_key_version`, `is_active: true`, `revoked_at: null`); if the database collision guard `UNIQUE (encryption_key_version, encryption_iv)` detects a nonce collision, regenerate a fresh 12-byte CSPRNG nonce and retry encryption safely without ever reusing a nonce under the same key. Record `SYNC_CREDENTIAL_CREATED` in `AuditLog`.
  4. Return the plaintext 64-character lowercase hex `webhook_secret` **exactly once** in the `201 Created` response (used directly as UTF-8 bytes `Buffer.from(webhook_secret, 'utf8')` by both the external sender and the server as the HMAC key: `HMAC-SHA256(key = Buffer.from(webhook_secret, 'utf8'), message = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), req.rawBody]))`, with no hex-decoding before HMAC, no `secret_hash` signing, and no SHA-256 key derivation). Never return `signing_key_sha256` or any derived signing key, and never persist plaintext `webhook_secret` in PostgreSQL, application logs, `AuditLog`, error messages, or subsequent credential-list responses.
- **Key Rotation Operational Lifecycle (`F7-CRYPTO-1`)**:
  1. Generate a new 32-byte random AES-256 key (64 lowercase hex characters) and assign the next integer version `N + 1`.
  2. Deploy the new key version in `WEBHOOK_SECRET_ENCRYPTION_KEYS` alongside all existing key versions referenced by stored `sync_webhook_credentials` rows.
  3. Set `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION = N + 1` so all new credentials (`POST /sync/credentials`) encrypt with key version `N + 1`.
  4. Existing credentials remain seamlessly decryptable during webhook verification because `WebhookSignatureGuard` looks up the key in `WEBHOOK_SECRET_ENCRYPTION_KEYS` by each row's `credential.encryption_key_version`.
  5. Run `SyncCredentialService.reencryptCredentialsToCurrentKeyVersion()` to atomically re-encrypt stored credentials in place (`SELECT ... FOR UPDATE`): decrypting `encrypted_secret` with the old key (`AAD = UTF8("${tenant_id}:${lower(source)}:${old_version}")`), generating a **fresh** 12-byte CSPRNG nonce (`encryption_iv`), re-encrypting `Buffer.from(webhook_secret, 'utf8')` under `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION` (`AAD = UTF8("${tenant_id}:${lower(source)}:${new_version}")`), and updating `encrypted_secret`, `encryption_iv`, `encryption_auth_tag`, and `encryption_key_version` without changing the underlying `webhook_secret` or `secret_hash`.
  6. Retain old key versions in `WEBHOOK_SECRET_ENCRYPTION_KEYS` until zero active or retained/revoked rows in `sync_webhook_credentials` reference that `encryption_key_version` (since `POST /sync/credentials/{id}/revoke` sets `is_active = false` without deleting rows).
- **Response (`201 Created`)**:
  ```json
  {
    "id": "uuid-credential",
    "tenant_id": "uuid-tenant",
    "source": "salla",
    "is_active": true,
    "webhook_secret": "64-hex-char-one-time-secret",
    "created_at": "2026-10-30T19:00:00.000Z",
    "revoked_at": null
  }
  ```

### GET /sync/credentials
List webhook credentials (`SyncWebhookCredential`) for the active tenant, exposing safe metadata only and never exposing `webhook_secret`, `secret_hash`, `encrypted_secret`, `encryption_iv`, `encryption_auth_tag`, encryption keys, or decrypted values (`F10-1`).
- **Required Permission**: `sync:credentials`
- **Authorized Roles**: `ADMIN`
- **Response (`200 OK`)**: List of `{ "id", "tenant_id", "source", "is_active", "created_at", "revoked_at" }`.

### POST /sync/credentials/{id}/revoke
Revoke an active `SyncWebhookCredential` in the active tenant (`F10-1`).
- **Required Permission**: `sync:credentials`
- **Authorized Roles**: `ADMIN`
- **Logic**: Locks the `SyncWebhookCredential` row (`SELECT ... FOR UPDATE`), sets `is_active = false` and `revoked_at = CURRENT_TIMESTAMP`, and records `SYNC_CREDENTIAL_REVOKED` in `AuditLog`.
- **Response (`200 OK`)**: `{ "id", "tenant_id", "source", "is_active": false, "created_at", "revoked_at" }`.

### POST /sync/webhook/{source}
Inbound webhook for external channel orders (idempotent per `(tenant_id, source, external_id)`).
- **Authentication (`WebhookSignatureGuard`, `F10-1`, `F7-CRYPTO-1`..`F7-CRYPTO-3`)**:
  - Exempt from `JwtAuthGuard` and `PermissionsGuard`; protected exclusively by `WebhookSignatureGuard`.
  - **Raw Body Requirement (`F7-CRYPTO-3`)**: NestJS bootstrap (`src/main.ts`, `T008`) MUST enable `rawBody: true` so `WebhookSignatureGuard` reads the exact unparsed HTTP request body `Buffer` (`req.rawBody`) prior to JSON parsing or whitespace/key normalization.
  - **Required Headers**:
    - `X-Sync-Tenant-Slug: <tenant_slug>` (required; normalized lowercase).
    - `X-Sync-External-Id: <external_event_id>` (required; non-empty idempotency key; `400 Bad Request` `VALIDATION_ERROR` if missing/empty).
    - `X-Sync-Timestamp: <unix_epoch_seconds>` (required; base-10 integer UNIX epoch seconds within `±300` seconds of server UTC clock).
    - `X-Sync-Signature: v1=<64-lowercase-hex-chars>` (required; MUST match `^v1=[0-9a-f]{64}$`, representing the lowercase hex digest of `HMAC-SHA256(key = Buffer.from(webhook_secret, 'utf8'), message = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), req.rawBody]))`, where both sender and server use the UTF-8 bytes of the 64-character lowercase hex `webhook_secret` string `Buffer.from(webhook_secret, 'utf8')` directly as the HMAC key; hex-decoding `webhook_secret` before HMAC, using `secret_hash` as the HMAC key, or applying SHA-256 key derivation is strictly prohibited).
  - **Two-Tier Rate Limiting & Verification, Decryption & Constant-Time Comparison (`F7-CRYPTO-1`..`F7-CRYPTO-3`, `FR-020`)**:
    0. **Pre-Authentication Rate Limit (before HMAC verification)**: Resolve `client_ip` using the trusted-proxy policy in §0 (ignoring `X-Forwarded-For` unless `req.socket.remoteAddress` is in `TRUSTED_PROXY_IPS`, in which case selecting the first rightmost non-trusted hop) and enforce the per-IP (`webhook:preauth:ip:${client_ip}`) and per-source+IP (`webhook:preauth:source_ip:${lower(source)}:${client_ip}`) rate limits (`429 Too Many Requests` `RATE_LIMIT_EXCEEDED` with `Retry-After` if exceeded). Never use the unverified `X-Sync-Tenant-Slug` header as a rate-limit key before HMAC verification.
    1. Validate `X-Sync-Tenant-Slug`, `X-Sync-Timestamp` (base-10 integer UNIX seconds with `|now - timestamp| <= 300`), `X-Sync-Signature` (strict regex `^v1=[0-9a-f]{64}$`), and non-empty `Buffer.isBuffer(req.rawBody)`. If any header is missing/malformed, outside the `±300s` replay window, or `X-Sync-Tenant-Slug` does not match an active tenant (`tenants.is_active = true`), record an unattributable pre-auth failure via `public.record_pre_auth_audit_log('SYNC_WEBHOOK_AUTH_FAILURE', ...)` and return `401 Unauthorized` (`WEBHOOK_AUTH_UNAUTHORIZED`) without throwing an unhandled error.
    2. Once the active `Tenant` is resolved from `tenants`, open a transaction with `SET LOCAL app.current_tenant_id = '<tenant.id>'` and load the active `SyncWebhookCredential` for `(tenant.id, lower(source))` (`is_active = true AND revoked_at IS NULL`).
    3. Look up the 32-byte AES-256 key in `WEBHOOK_SECRET_ENCRYPTION_KEYS` matching `credential.encryption_key_version` (never falling back to another key version; if the key version is missing from the keyring, log a safe operational error without exposing secrets, record `SYNC_WEBHOOK_AUTH_FAILURE` in `AuditLog`, and fail closed with `401 Unauthorized` `WEBHOOK_AUTH_UNAUTHORIZED`).
    4. Decrypt `encrypted_secret` (128 lowercase hex chars -> 64 ciphertext bytes) **only in memory** using AES-256-GCM with `encryption_iv` (24 hex chars -> 12-byte nonce), `encryption_auth_tag` (32 hex chars -> 16-byte tag), and `AAD = UTF8("${tenant.id}:${lower(source)}:${credential.encryption_key_version}")`, recovering the 64-byte UTF-8 `webhook_secret`.
    5. Extract the 64-character lowercase hex digest after `v1=` from `X-Sync-Signature` and decode it into a 32-byte `Buffer` (`providedSigBuf = Buffer.from(sigHex, 'hex')`).
    6. Compute the expected 32-byte HMAC-SHA256 digest `Buffer` directly over the original `req.rawBody` `Buffer` (`expectedSigBuf = createHmac('sha256', Buffer.from(webhook_secret, 'utf8')).update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), req.rawBody])).digest()`).
    7. Verify `providedSigBuf.byteLength === expectedSigBuf.byteLength && expectedSigBuf.byteLength === 32` **before** calling `crypto.timingSafeEqual(providedSigBuf, expectedSigBuf)` so malformed or wrong-length signatures never throw `RangeError`.
    8. If no active credential exists, AES-256-GCM authentication/decryption fails, or `crypto.timingSafeEqual` returns `false`, record `SYNC_WEBHOOK_AUTH_FAILURE` in tenant-scoped `AuditLog` and return `401 Unauthorized` (`WEBHOOK_AUTH_UNAUTHORIZED`).
    9. **Post-HMAC Tenant Rate Limit (after HMAC verification succeeds)**: Enforce the authenticated tenant-and-source rate limit keyed strictly by the verified `tenant.id` and normalized `source` (`webhook:tenant:${tenant.id}:${lower(source)}`), returning `429 Too Many Requests` (`RATE_LIMIT_EXCEEDED` with `Retry-After`) if exceeded.
- **Request**:
  ```json
  {
    "customer_id": "uuid-customer",
    "items": [
      { "product_id": "uuid-product", "quantity": 2 }
    ]
  }
  ```
- **Idempotency & Three-Phase Transaction Execution (`F7-1`, `F7-2`, `F7-4`, `F7-5`)**:
  1. **Phase A — Ingestion & Claim Transactions (`Ingestion TX` -> `Claim TX`)**:
     - **Ingestion TX**:
       - Inside a short transaction with `SET LOCAL app.current_tenant_id = '<tenant.id>'`, check `SyncLog` for `(tenant_id, lower(source), external_id)` (`UNIQUE (tenant_id, source, external_id)`).
       - **If `SyncLog` already exists**:
         - `status == "SUCCEEDED"`: Commit and return `200 OK` with the existing `SyncLog` (including `order_id`). No duplicate order, reservation, or `SyncAttempt` is created.
         - `status IN ("PENDING", "PROCESSING", "RETRY_SCHEDULED")`: Commit and return `202 Accepted` with the current `SyncLog` state without starting a duplicate concurrent execution.
         - `status == "FAILED_PERMANENT"`: Commit and return `409 Conflict` (`last_error_code`, e.g., `INSUFFICIENT_STOCK` or `MAX_RETRIES_EXHAUSTED`) with the existing `SyncLog` without re-executing or incrementing `attempt_count`.
       - **If `SyncLog` is new**:
         - Insert the new `SyncLog` with `status = 'PENDING'`, `attempt_count = 0`, `max_attempts = 5`, inbound event identity (`tenant_id`, `lower(source)`, `external_id`, `event_type = 'ORDER_CREATE'`), and `payload`.
         - **Commit `Ingestion TX` (`COMMIT`)** so the inbound event is durably persisted in `PENDING` (`attempt_count = 0`). (If a concurrent duplicate webhook races on `UNIQUE (tenant_id, source, external_id)`, resolve the unique conflict by reading the existing `SyncLog` and returning the corresponding `200 OK` / `202 Accepted` / `409 Conflict` duplicate-delivery response.)
     - **Claim TX**:
       - Immediately after `Ingestion TX` commits, open a **new, separate short transaction** with `SET LOCAL app.current_tenant_id = '<tenant.id>'` and lock the newly ingested `SyncLog` row (`SELECT ... FOR UPDATE`). If a concurrent worker already claimed the row (`status <> 'PENDING'`), commit and return `202 Accepted` with the current `SyncLog` state without starting a duplicate execution.
       - Transition `PENDING -> PROCESSING`, increment `attempt_count` **exactly once** to `1` (**`Claim TX` is the ONLY place where `attempt_count` is ever incremented**), set `processing_started_at = CURRENT_TIMESTAMP`, `lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '60 seconds'`, `lease_token = gen_random_uuid()`, `active_trigger_source = 'WEBHOOK'`, `next_retry_at = NULL`, `next_trigger_source = NULL`, and `last_attempted_at = CURRENT_TIMESTAMP`, and **commit `Claim TX` (`COMMIT`)**.
  2. **Phase B — Domain Execution Transaction (`Domain TX`)**:
     - Begin the independent `Domain TX` **only after `Claim TX` has committed**, opening a **new, separate database transaction** with `SET LOCAL app.current_tenant_id = '<tenant.id>'`.
     - Lock `SyncLog` (`SELECT ... FOR UPDATE`) and verify `status == 'PROCESSING'`, `lease_token == claimed_lease_token`, and `lease_expires_at > CURRENT_TIMESTAMP`.
     - Execute atomic order creation and allocation (`OrderService.create` with `auto_allocate: true`):
       - **On Domain Success**: Within the **same** `Domain TX`, insert the append-only `SyncAttempt` (`attempt_number = SyncLog.attempt_count` (`1`), `lease_token = claimed_lease_token`, `trigger_source = 'WEBHOOK'`, `status = 'SUCCEEDED'`, `pg_sqlstate = NULL`, `http_status = NULL`, `error_code = NULL`, `error_message = NULL`, `duration_ms`), update `SyncLog` to `status = 'SUCCEEDED'`, `order_id = order.id`, `completed_at = CURRENT_TIMESTAMP`, `processing_started_at = NULL`, `lease_expires_at = NULL`, `lease_token = NULL`, `active_trigger_source = NULL`, `next_retry_at = NULL`, `next_trigger_source = NULL`, commit `Domain TX` (`COMMIT`), and return `201 Created` + `SyncLog`.
       - **On Domain Failure**: Roll back the **entire** `Domain TX` (`ROLLBACK`), ensuring zero partial orders, zero stock reservations, and zero stock movements are persisted, and proceed immediately to **Phase C**.
  3. **Phase C — Failure Persistence Transaction (`Failure TX`)**:
     - After `Domain TX` has rolled back, open a **fresh database transaction** with `SET LOCAL app.current_tenant_id = '<tenant.id>'`.
     - Lock `SyncLog` (`SELECT ... FOR UPDATE`) and verify `status == 'PROCESSING'` and `lease_token == claimed_lease_token` (if the lease was already recovered after a timeout, exit without inserting a duplicate `SyncAttempt`).
     - Classify the failure using separated error namespaces (`F7-4`) and **without incrementing `attempt_count`**:
       - **Retryable Transient Failure** (PostgreSQL deadlock `pg_sqlstate = '40P01'` -> `error_code = 'DB_DEADLOCK'`, lock timeout `'55P03'` -> `'DB_LOCK_TIMEOUT'`, query timeout `'57014'` -> `'DB_QUERY_TIMEOUT'`, serialization failure `'40001'` -> `'DB_SERIALIZATION_FAILURE'`, or transient DB unavailability -> `'DB_TRANSIENT_UNAVAILABLE'`):
         - Insert append-only `SyncAttempt` (`attempt_number = SyncLog.attempt_count`, `lease_token = claimed_lease_token`, `trigger_source = 'WEBHOOK'`, `status = 'FAILED_RETRYABLE'`, `pg_sqlstate`, `http_status`, `error_code`, sanitized `error_message`, `duration_ms`).
         - Because `attempt_count = 1 < max_attempts (5)`, compute exponential backoff $\text{delay\_seconds} = \min(30 \times 2^{1 - 1}, 3600) = 30\text{s}$, update `SyncLog` to `status = 'RETRY_SCHEDULED'`, `next_retry_at = CURRENT_TIMESTAMP + INTERVAL '30 seconds'`, `next_trigger_source = 'AUTO_RETRY'`, `last_pg_sqlstate`, `last_http_status`, `last_error_code`, `last_error_message`, clear lease fields (`processing_started_at = NULL`, `lease_expires_at = NULL`, `lease_token = NULL`, `active_trigger_source = NULL`), commit `Failure TX`, and return `202 Accepted` + `SyncLog`.
       - **Permanent Business/Validation Failure** (`VALIDATION_ERROR` `400`, `RESOURCE_NOT_FOUND` `404`, `VARIANT_PARENT_NOT_SELLABLE` `400`, or `INSUFFICIENT_STOCK` `409`):
         - Insert append-only `SyncAttempt` (`attempt_number = SyncLog.attempt_count`, `lease_token = claimed_lease_token`, `trigger_source = 'WEBHOOK'`, `status = 'FAILED_PERMANENT'`, `pg_sqlstate = NULL`, `http_status = NULL`, `error_code`, sanitized `error_message`, `duration_ms`).
         - Update `SyncLog` to `status = 'FAILED_PERMANENT'`, `next_retry_at = NULL`, `next_trigger_source = NULL`, `last_pg_sqlstate = NULL`, `last_http_status = NULL`, `last_error_code`, `last_error_message`, clear lease fields, commit `Failure TX`, and return the corresponding `400` / `404` / `409` response containing `sync_log_id`.

### GET /sync/logs
List synchronization logs (`SyncLog`) for the active tenant (paginated).
- **Required Permission**: `sync:read`
- **Authorized Roles**: `ADMIN`, `MANAGER` (`403 Forbidden` `INSUFFICIENT_PERMISSIONS` for `VIEWER`)
- **Query Params**: `status` (`PENDING | PROCESSING | SUCCEEDED | RETRY_SCHEDULED | FAILED_PERMANENT`), `source`, `external_id`, `from` (ISO-8601 UTC), `to` (ISO-8601 UTC), `page`, `limit`.
- **Ordering**: `created_at DESC, id DESC`.
- **Response**: `200 OK` + paginated list of `SyncLog`.

### GET /sync/logs/{id}
Retrieve a single `SyncLog` by UUID along with its ordered `SyncAttempt` execution history (`attempts`).
- **Required Permission**: `sync:read`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Response (`200 OK`)**:
  ```json
  {
    "id": "uuid-sync-log",
    "tenant_id": "uuid-tenant",
    "source": "salla",
    "external_id": "ORD-123",
    "event_type": "ORDER_CREATE",
    "status": "RETRY_SCHEDULED",
    "attempt_count": 1,
    "max_attempts": 5,
    "next_retry_at": "2026-10-30T19:10:30.000Z",
    "next_trigger_source": "AUTO_RETRY",
    "processing_started_at": null,
    "lease_expires_at": null,
    "lease_token": null,
    "active_trigger_source": null,
    "last_pg_sqlstate": "55P03",
    "last_http_status": null,
    "last_error_code": "DB_LOCK_TIMEOUT",
    "last_error_message": "Lock acquisition timed out while reserving inventory",
    "order_id": null,
    "last_attempted_at": "2026-10-30T19:10:00.000Z",
    "completed_at": null,
    "created_at": "2026-10-30T19:10:00.000Z",
    "updated_at": "2026-10-30T19:10:00.045Z",
    "attempts": [
      {
        "id": "uuid-sync-attempt-1",
        "sync_log_id": "uuid-sync-log",
        "attempt_number": 1,
        "lease_token": "uuid-lease-1",
        "trigger_source": "WEBHOOK",
        "status": "FAILED_RETRYABLE",
        "pg_sqlstate": "55P03",
        "http_status": null,
        "error_code": "DB_LOCK_TIMEOUT",
        "error_message": "Lock acquisition timed out while reserving inventory",
        "started_at": "2026-10-30T19:10:00.000Z",
        "finished_at": "2026-10-30T19:10:00.045Z",
        "duration_ms": 45
      }
    ]
  }
  ```

### POST /sync/logs/{id}/retry
Accelerate a scheduled retry for a `SyncLog` currently in `RETRY_SCHEDULED` status (`F7-3`).
- **Required Permission**: `sync:retry`
- **Authorized Roles**: `ADMIN`, `MANAGER`
- **Strict State & Retry Budget Rules (`F7-2`, `F7-3`)**:
  1. Open a transaction with `SET LOCAL app.current_tenant_id = '<tenant_uuid>'` and lock the `SyncLog` row (`SELECT ... FOR UPDATE`; `404 Not Found` if absent in the active tenant).
  2. **Allowed State (`RETRY_SCHEDULED` only)**:
     - If `SyncLog.status` is `PENDING`, `PROCESSING`, `SUCCEEDED`, or `FAILED_PERMANENT` (whether due to a permanent business/validation failure such as `INSUFFICIENT_STOCK` or retry exhaustion `MAX_RETRIES_EXHAUSTED`), reject the request with `409 Conflict` (`INVALID_SYNC_RETRY_STATE`). Permanent failures (`FAILED_PERMANENT`) cannot be manually retried in the MVP; external channels must submit a new webhook event after catalog/stock remediation.
     - Verify `SyncLog.attempt_count < SyncLog.max_attempts` (`1 <= attempt_count < 5`).
  3. **Schedule Acceleration Only (No Domain Execution in HTTP Request)**:
     - Set `SyncLog.next_retry_at = CURRENT_TIMESTAMP`, `SyncLog.next_trigger_source = 'MANUAL_RETRY'`, and `SyncLog.updated_at = CURRENT_TIMESTAMP`.
     - **Do NOT** increment or reset `attempt_count`, **do NOT** modify `max_attempts` (`5`), and **do NOT** execute order creation or inventory allocation inside the HTTP request.
     - Record `SYNC_MANUAL_RETRY` in `AuditLog` and commit.
     - `SyncRetryWorker` claims the due `SyncLog` on its next polling cycle via Phase A Claim TX (incrementing `attempt_count = attempt_count + 1` and setting `active_trigger_source = 'MANUAL_RETRY'`) and executes Phase B / Phase C.
- **Response**: `202 Accepted` + Updated `SyncLog` (`status: "RETRY_SCHEDULED"`, `next_retry_at`, `next_trigger_source: "MANUAL_RETRY"`).

### Internal Background Retry & Lease-Recovery Worker (`SyncRetryWorker` — `SYSTEM_WORKER`, `F7-5`, `F7-6`)
- **Execution Context**: Runs internally inside the NestJS process under the non-HTTP `SYSTEM_WORKER` execution context using the standard runtime database role `omnistock_app` (`NOBYPASSRLS`). Never exposed as a public endpoint and never assignable to user JWTs.
- **RLS-Safe Per-Tenant Polling & Lease-Recovery Algorithm**:
  1. **Query Active Tenants**: Query `SELECT id FROM tenants WHERE is_active = true ORDER BY id ASC` on the global root `tenants` table (which is not RLS-protected).
  2. **Recover Expired `PROCESSING` Leases (`F7-5`)**: For each `tenant_id`, open a short transaction with `SET LOCAL app.current_tenant_id = '<tenant_id>'` and lock expired `PROCESSING` rows:
     ```sql
     SELECT * FROM sync_logs
     WHERE status = 'PROCESSING' AND lease_expires_at <= CURRENT_TIMESTAMP
     ORDER BY lease_expires_at ASC, id ASC
     LIMIT 25
     FOR UPDATE SKIP LOCKED;
     ```
     For each expired row (where `attempt_count = k` was already incremented when Phase A claimed the lease, and the previous worker crashed or timed out before Phase B or Phase C committed):
     - Insert a single append-only `SyncAttempt` (`attempt_number = k`, `lease_token = SyncLog.lease_token`, `trigger_source = SyncLog.active_trigger_source`, `status = 'FAILED_RETRYABLE'`, `pg_sqlstate = NULL`, `http_status = NULL`, `error_code = 'PROCESSING_LEASE_EXPIRED'`, `error_message = 'Worker processing lease expired before completion'`, `started_at = SyncLog.processing_started_at`, `finished_at = CURRENT_TIMESTAMP`, `duration_ms`) **without incrementing `attempt_count`** and without mutating any existing `SyncAttempt` row (`UNIQUE (tenant_id, sync_log_id, lease_token)` guarantees idempotency).
     - Clear lease fields (`processing_started_at = NULL`, `lease_expires_at = NULL`, `lease_token = NULL`, `active_trigger_source = NULL`).
     - If $k < \text{max\_attempts}$ ($k < 5$): transition `SyncLog` to `status = 'RETRY_SCHEDULED'`, `next_retry_at = CURRENT_TIMESTAMP + min(30 * 2^(k - 1), 3600) seconds`, `next_trigger_source = 'AUTO_RETRY'`, `last_error_code = 'PROCESSING_LEASE_EXPIRED'`.
     - If $k = \text{max\_attempts}$ ($k = 5$): transition `SyncLog` to `status = 'FAILED_PERMANENT'`, `next_retry_at = NULL`, `next_trigger_source = NULL`, `last_error_code = 'MAX_RETRIES_EXHAUSTED'`, `last_error_message = 'Maximum synchronization attempts (5) exhausted after processing lease expiry'`.
     - Commit the lease-recovery transaction.
  3. **Claim Next Due `PENDING` or `RETRY_SCHEDULED` Event (Phase A `Claim TX`)**: For each `tenant_id`, open a short transaction with `SET LOCAL app.current_tenant_id = '<tenant_id>'`, select and lock the next claimable row:
     ```sql
     SELECT * FROM sync_logs
     WHERE (status = 'PENDING' OR (status = 'RETRY_SCHEDULED' AND next_retry_at <= CURRENT_TIMESTAMP))
       AND attempt_count < max_attempts
     ORDER BY COALESCE(next_retry_at, created_at) ASC, id ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED;
     ```
     Transition the row to `status = 'PROCESSING'`, increment `attempt_count = attempt_count + 1` ($k \in \{1..5\}$), set `active_trigger_source = COALESCE(next_trigger_source, 'WEBHOOK')`, `next_retry_at = NULL`, `next_trigger_source = NULL`, `processing_started_at = CURRENT_TIMESTAMP`, `lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '60 seconds'`, `lease_token = gen_random_uuid()`, `last_attempted_at = CURRENT_TIMESTAMP`, and commit Phase A.
  4. **Execute Phase B (`Domain TX`) and Phase C (`Failure TX`)**: Run Phase B in a fresh tenant-scoped transaction; on failure, roll back Phase B completely and run Phase C in a fresh tenant-scoped transaction (scheduling `RETRY_SCHEDULED` with $\text{delay\_seconds} = \min(30 \times 2^{k - 1}, 3600)$ when a retryable failure occurs at $k < 5$, or transitioning to `FAILED_PERMANENT` with `last_error_code = 'MAX_RETRIES_EXHAUSTED'` when $k = 5$).
- **Worker Lifecycle, Test Determinism & Graceful Shutdown (`FR-022`, `FR-023`)**:
  - **Configuration & Single-Flight Guard**: Controlled by `SYNC_WORKER_ENABLED` (`true` in development/production, `false` in HTTP integration tests so tests invoke `await syncRetryWorker.runTick()` deterministically), `SYNC_WORKER_POLL_INTERVAL_MS` (default `5000`ms), `SYNC_WORKER_BATCH_SIZE` (default `10`), and an in-process single-flight guard (`isTickRunning`) preventing overlapping poll cycles.
  - **Ordered Shutdown & Complete Multi-Phase Job Drain (`SIGTERM` / `SIGINT`)**: Each `SyncLog` processing job is tracked as a **single continuous logical unit** from initial start until either `Phase B` commits `SUCCEEDED` or `Phase C` failure handling commits `RETRY_SCHEDULED` or `FAILED_PERMANENT`. The in-flight job tracker remains active continuously across `Phase A.1 — Ingestion Transaction` (when applicable for inbound webhooks), `Phase A.2 — Claim Transaction`, `Phase B — Domain Transaction`, and `Phase C — Failure Transaction`, and is **never** released at intermediate transaction boundaries between `Phase A`, `Phase B`, and `Phase C` (releasing only in an outer `finally` block after the complete multi-phase job finishes). When shutdown begins (`app.enableShutdownHooks()`), `SyncRetryWorker` immediately clears its poll timer, sets `isShuttingDown = true` (stopping any new tenant iteration or Phase A claim), and awaits all currently tracked complete multi-phase jobs (including `Phase C` failure persistence when `Phase B` fails) alongside tracked in-flight HTTP requests in `beforeApplicationShutdown` up to `SHUTDOWN_DRAIN_TIMEOUT_MS` (default `15000`ms). If `SHUTDOWN_DRAIN_TIMEOUT_MS` expires before a tracked job completes, the shutdown coordinator logs a structured timeout warning without silently marking unfinished jobs as completed (relying on the 60-second `lease_expires_at` recovery for any row remaining in `PROCESSING`), and closes the TypeORM `DataSource` pool only after the drain procedure finishes.

---

## 7. Health, Liveness & Readiness Probes (`FR-022`)

### GET /health/live
Lightweight process liveness probe.
- **Authentication**: Public infrastructure probe (narrowly exempted from `JwtAuthGuard` and `PermissionsGuard` in §0).
- **Logic**: Verifies the Node.js event loop and HTTP server are responsive. Must **never** depend on database connectivity, external I/O, or tenant context, and must **never** expose internal infrastructure details.
- **Response (`200 OK`)**:
  ```json
  {
    "status": "ok"
  }
  ```

### GET /health/ready
Readiness probe verifying runtime database availability and shutdown drain state.
- **Authentication**: Public infrastructure probe (narrowly exempted from `JwtAuthGuard` and `PermissionsGuard` in §0).
- **Logic**:
  - If the application is shutting down (`isShuttingDown === true` after receiving `SIGTERM` or `SIGINT`), immediately returns `503 Service Unavailable` with `{ "status": "not_ready" }` so load balancers stop routing new traffic while in-flight HTTP requests and active `SyncRetryWorker` transactions drain.
  - Otherwise, executes a lightweight `SELECT 1` query over the runtime `omnistock_app` database connection pool.
  - Must **never** query any of the 17 tenant-owned tables, must **never** require or set `app.current_tenant_id`, and must **never** expose database hostnames, role names, pool statistics, versions, or error stack traces in the response.
- **Response (`200 OK` when ready)**:
  ```json
  {
    "status": "ready"
  }
  ```
- **Response (`503 Service Unavailable` when shutting down or DB unreachable)**:
  ```json
  {
    "status": "not_ready"
  }
  ```
