# OmniStock MVP — Phase 5 Postman Smoke Testing Guide

This directory contains the complete Postman collection and automated test harness for **Phase 5: Automated Order Allocation & Reservation (User Story 3)** of the OmniStock MVP.

## Artifacts

- **`OmniStock-Phase-5.postman_collection.json`**: Sequential, automated test suite covering Customer management, order snapshot immutability, 5-state order lifecycle (`DRAFT`, `PENDING`, `ALLOCATED`, `SHIPPED`, `CANCELLED`), deterministic multi-warehouse split allocation, all-or-nothing insufficient stock rollback, and multi-tenant isolation.
- **`OmniStock-Local.postman_environment.json`**: Environment file containing `baseUrl` (`http://localhost:3000`).
- **`../scripts/run-phase5-smoke-tests.ps1`**: Automated end-to-end runner that builds the app, boots the NestJS server, executes Newman, verifies assertions, and performs clean shutdown.

## Executing Smoke Tests

### Automated Runner (Recommended)

From the project root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-phase5-smoke-tests.ps1
```

### Manual Execution with Newman

1. Ensure the NestJS application is running:
   ```bash
   npm run start:dev
   ```
2. Run Newman:
   ```bash
   npx newman run postman/OmniStock-Phase-5.postman_collection.json -e postman/OmniStock-Local.postman_environment.json --reporters cli
   ```

## Covered Scenarios & Assertions

1. **Setup & Authentication**:
   - Provision isolated Tenant A and Tenant B.
   - Obtain JWT access tokens for tenant administrators.
2. **Customer Management**:
   - Create customer with name, email, and phone.
   - Enforce tenant-scoped uniqueness (`409 DUPLICATE_CUSTOMER_EMAIL`).
   - Allow duplicate customer email across distinct tenants (Tenant A vs. Tenant B).
   - Retrieve customer by ID and list customers with search/pagination.
3. **Prerequisites (Catalog & Inventory)**:
   - Create sellable product and two warehouses with different priorities (WH1: priority 1, WH2: priority 2).
   - Seed stock across warehouses (WH1: 5 units, WH2: 7 units).
4. **Order Creation & Historical Snapshots**:
   - Create `DRAFT` order with `auto_allocate: false`, verifying 0 allocations and 0 reservations.
   - Verify historical `customer_name_snapshot` and `customer_email_snapshot` remain immutable even when the Customer entity is updated.
   - Transition order from `DRAFT -> PENDING` via `POST /orders/:id/submit`.
5. **Split Warehouse Allocation & All-Or-Nothing Invariant**:
   - Create order for 10 units with `auto_allocate: true`.
   - Verify split across priority-ordered warehouses (5 from WH1, 5 from WH2).
   - Reject order exceeding total available stock with `409 Conflict` (`INSUFFICIENT_STOCK`), verifying 0 partial reservations.
   - Allocate `PENDING` order via `POST /orders/:id/allocate`.
6. **Shipping & Cancellation Lifecycle**:
   - Ship allocated order via `POST /orders/:id/ship`, verifying decrement of `on_hand` and `reserved`, and `SALE` `StockMovement` creation.
   - Reject cancellation of shipped order (`409 Conflict` `INVALID_ORDER_TRANSITION`).
   - Cancel allocated order via `POST /orders/:id/cancel`, restoring `reserved` stock and `available` inventory.
7. **Cross-Tenant Security**:
   - Verify Tenant B receives `404 Not Found` when trying to view, allocate, or ship Tenant A's orders or customers.

