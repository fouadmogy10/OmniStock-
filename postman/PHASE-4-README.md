# OmniStock MVP — Phase 4 Postman Smoke Test Guide

This directory contains the executable Postman Collection and environment configuration for **OmniStock Phase 4: User Story 2 — Accurate Inventory Tracking & Movements**.

---

## 1. Test Suite Overview

- **Collection**: `postman/OmniStock-Phase-4.postman_collection.json`
- **Environment**: `postman/OmniStock-Local.postman_environment.json`
- **Total Requests**: 49 sequential HTTP requests across 8 logical test folders
- **Total Assertions**: 94 automated checks
- **Target Base URL**: `http://localhost:3000`

### Coverage Matrix

| Folder | Scope & Scenarios Covered |
|---|---|
| **0. Setup & Auth** | Onboards dedicated Phase 4 test tenant (`POST /tenants`) and logs in as `ADMIN` (`POST /auth/login`) to acquire JWT. |
| **1. Categories** | Create category (`POST /categories`), list categories (`GET /categories`), update description (`PATCH /categories/:id`), negative duplicate case-insensitive name (`409 DUPLICATE_CATEGORY_NAME`). |
| **2. Products & Variants** | Create standalone product (`POST /products`), create variant parent container (`is_variant_parent: true`), create child variant SKU under parent, fetch parent with `variants` array (`GET /products/:id`), negative duplicate SKU (`409 DUPLICATE_PRODUCT_SKU`), negative duplicate barcode (`409 DUPLICATE_PRODUCT_BARCODE`), negative multi-level variant nesting (`400 VALIDATION_ERROR`), negative negative price (`400 VALIDATION_ERROR`). |
| **3. Warehouses** | Create Warehouse 1 (`priority: 1`), create Warehouse 2 (`priority: 2`), list ordered by priority ascending (`GET /warehouses`), negative duplicate name (`409 DUPLICATE_WAREHOUSE_NAME`). |
| **4. Inventory Stock & Movements** | Negative stock adjustment on variant parent (`400 VARIANT_PARENT_NOT_SELLABLE`), negative delta = 0 (`400 VALIDATION_ERROR`), initial intake +30 (`POST /inventory/adjust`), negative insufficient stock (-50 from 30) (`409 INSUFFICIENT_STOCK`), retrieve levels confirming formula `available = on_hand - reserved` (`GET /inventory/levels`), retrieve immutable `StockMovement` ledger entry (`GET /inventory/movements`), verify reserved `type=RETURN` returns 0 items in MVP. |
| **5. Low-Stock Alerts Lifecycle** | Configure threshold = 15 (`PATCH /inventory/items/:id/threshold`), deduct stock to 10 (triggers `OPEN` alert), retrieve `OPEN` alert confirming `current_available = 10`, retrieve single alert by ID (`GET /alerts/low-stock/:id`), deduct further stock to 7 (assert deduplication: same alert ID updated to `current_available = 7`), replenish stock to 27 (assert auto-resolution: alert transitioned to `RESOLVED` with non-null `resolved_at`). |
| **6. Stock Transfers** | Create `DRAFT` transfer of 10 units (`POST /transfers`), negative same source and destination warehouse (`400 VALIDATION_ERROR`), dispatch transfer (`POST /transfers/:id/dispatch` -> `IN_TRANSIT`), verify source `on_hand = 17` and destination `in_transit = 10` with `available = 0` (verifying `in_transit` never inflates `available`), negative repeated dispatch (`409 INVALID_TRANSFER_TRANSITION`), negative cancel `IN_TRANSIT` transfer (`409 INVALID_TRANSFER_TRANSITION`), receive transfer (`POST /transfers/:id/receive` -> `RECEIVED`), verify destination `on_hand = 10` and `in_transit = 0`, negative repeated receive (`409 INVALID_TRANSFER_TRANSITION`), create and cancel new `DRAFT` transfer (`POST /transfers/:id/cancel` -> `CANCELLED`). |
| **7. Cross-Tenant Isolation** | Onboard second tenant and login as Admin, verify Tenant 2 receives `404 Not Found` (`PRODUCT_NOT_FOUND`) attempting to read Tenant 1's product, `404 Not Found` (`TRANSFER_NOT_FOUND`) attempting to read Tenant 1's transfer, and `404 Not Found` (`ALERT_NOT_FOUND`) attempting to read Tenant 1's alert. |

---

## 2. Automated One-Command Execution (Newman CLI)

Run the end-to-end PowerShell runner:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-phase4-smoke-tests.ps1
```

Or run Newman directly (ensure NestJS app is running on port 3000):

```bash
npx --yes newman run postman/OmniStock-Phase-4.postman_collection.json \
  -e postman/OmniStock-Local.postman_environment.json \
  --reporters cli \
  --color on
```

---

## 3. Postman Desktop Execution

1. Open **Postman Desktop**.
2. Click **Import** and select:
   - `postman/OmniStock-Phase-4.postman_collection.json`
   - `postman/OmniStock-Local.postman_environment.json`
3. Select **OmniStock Local Environment** in the top-right environment selector.
4. Right-click the **OmniStock Phase 4 - Catalog, Warehouses, Inventory & Transfers** collection and select **Run collection**.
5. Click **Run OmniStock Phase 4**. All 49 requests will execute sequentially.

