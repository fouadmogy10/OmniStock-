# OmniStock MVP — Phase 6 Postman Smoke Testing Guide

This directory contains the complete Postman collection and automated test harness for **Phase 6: Idempotent Synchronization, Webhook Authentication, Retries & Operational Dashboard (`F3`, `F7`, `F10-1`, `A5`, `A9`)** of the OmniStock MVP.

## Artifacts

- **`OmniStock-Phase-6.postman_collection.json`**: Sequential, automated test suite covering Webhook Credential Management, AES-256-GCM encryption with versioned keyring, HMAC-SHA256 signature verification over exact request bytes, 3-Phase Inbound Webhook Execution (`Ingestion TX`, `Claim TX`, `Domain TX`, `Failure TX`), Webhook Idempotency, Sync Log & Sync Attempt lifecycle, Manual Retry acceleration guard, and Operational Dashboard Summary (`GET /dashboard/summary`) with strict ISO-8601 UTC-offset validation.
- **`OmniStock-Local.postman_environment.json`**: Environment file containing `baseUrl` (`http://localhost:3000`).
- **`../scripts/run-phase6-smoke-tests.ps1`**: Automated end-to-end runner that builds the app, boots the NestJS server, executes Newman, verifies assertions, and performs clean shutdown.

## Executing Smoke Tests

### Automated Runner (Recommended)

From the project root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-phase6-smoke-tests.ps1
```

### Manual Execution with Newman

1. Ensure the NestJS application is running:
   ```bash
   npm run start:dev
   ```
2. Run Newman:
   ```bash
   npx newman run postman/OmniStock-Phase-6.postman_collection.json -e postman/OmniStock-Local.postman_environment.json --reporters cli
   ```

## Covered Scenarios & Assertions

1. **Setup & Authentication**:
   - Provision isolated Tenant A and Tenant B.
   - Obtain JWT access tokens for tenant administrators.
   - Seed prerequisite Warehouse, Product, Stock adjustment, and Customer in Tenant A.
2. **Sync Credentials Lifecycle (`T068`)**:
   - Provision Salla webhook credential (`POST /sync/credentials`).
   - Verify one-time 64-character lowercase hex `webhook_secret` returned in `201 Created`.
   - Verify ciphertexts (`encrypted_secret`, `encryption_iv`) and lookup hashes (`secret_hash`) are never exposed in responses.
   - List credentials (`GET /sync/credentials`) and verify safe metadata only.
3. **Inbound Webhook Orchestration & HMAC Signature (`T031`, `T032`, `T068`)**:
   - Compute `v1=HMAC-SHA256(timestamp.rawBody)` signature using CryptoJS in Pre-request script.
   - Submit webhook (`POST /sync/webhook/salla`) with valid signature; verify `201 Created` with created order and `SUCCEEDED` sync log.
   - Verify webhook idempotency: repeat request with exact same `X-Sync-External-Id` and payload; verify `200 OK` returning existing sync log without creating duplicate orders.
   - Reject malformed signature format with `401 Unauthorized` (`WEBHOOK_AUTH_UNAUTHORIZED`).
   - Reject timestamp outside `±300s` replay window with `401 Unauthorized` (`WEBHOOK_AUTH_UNAUTHORIZED`).
4. **Sync Logs, Attempts & Retries (`T062`, `T063`)**:
   - List sync logs (`GET /sync/logs`) with pagination and limit.
   - Retrieve sync log by ID (`GET /sync/logs/:id`) with ordered `attempts` array.
   - Reject manual retry on non-`RETRY_SCHEDULED` status (`POST /sync/logs/:id/retry`) with `409 Conflict` (`INVALID_SYNC_RETRY_STATE`).
5. **Operational Dashboard Summary (`T064`, `T065`)**:
   - Retrieve dashboard summary (`GET /dashboard/summary`) with valid ISO-8601 UTC-offset parameters.
   - Verify metric accuracy: `catalog_and_network` counts, 5-state `orders_by_status`, `period_order_value` gross amounts, and `inventory_quantity_summary`.
   - Verify explicit exclusion of cost and valuation metrics.
   - Enforce strict ISO-8601 validation: reject date-only strings and missing offsets with `400 Bad Request` (`VALIDATION_ERROR`).
   - Enforce bounded `limit` (reject `limit > 50` with `400 Bad Request`).
   - Scope metrics to specific `warehouse_id`.
6. **Multi-Tenant Isolation & Cleanup (`T068`, `T064`)**:
   - Verify Tenant B summary is completely isolated from Tenant A (zero products, orders, or inventory).
   - Verify Tenant B cannot retrieve Tenant A sync log (`404 Not Found`).
   - Revoke credential (`POST /sync/credentials/:id/revoke`) verifying `is_active = false`.

