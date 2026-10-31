# OmniStock — Phase 7 API Smoke Test Collection

## Overview

This Postman collection (`OmniStock-Phase-7.postman_collection.json`) validates the operational readiness, health probes, Swagger OpenAPI documentation, request correlation, and error envelope specifications implemented in Phase 7 (`T071`, `T070`, `T034`).

## Test Scenarios Covered

1. **Liveness Probe (`GET /health/live`)**:
   - Zero-database dependency.
   - Echoes incoming bounded `X-Request-Id` header.
   - Returns `{ "status": "ok" }` with HTTP 200.

2. **Readiness Probe (`GET /health/ready`)**:
   - Executes lightweight `SELECT 1` ping over runtime `omnistock_app` database connection without setting tenant context or querying tenant tables.
   - Returns `{ "status": "ready" }` with HTTP 200.

3. **OpenAPI 3.0 / Swagger UI (`GET /api/docs`)**:
   - Serves Swagger UI HTML bundle for interactive exploration.

4. **OpenAPI JSON Spec (`GET /api/docs-json`)**:
   - Returns valid OpenAPI 3.0 specification.
   - Documents Bearer JWT security scheme and API endpoint metadata.

5. **Validation Rejection Envelope (`POST /tenants`)**:
   - Sends non-whitelisted payload.
   - Verifies strict rejection with HTTP 400 and canonical error envelope: `statusCode`, `error_code`, `message`, `request_id`, and `timestamp`.
   - Confirms bidirectional correlation ID propagation.

## Automated Execution

Run via the automated PowerShell script:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-phase7-smoke-tests.ps1
```

