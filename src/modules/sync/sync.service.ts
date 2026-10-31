import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { SyncLog, SyncStatus } from './entities/sync-log.entity';
import {
  SyncAttempt,
  SyncAttemptStatus,
  SyncTriggerSource,
} from './entities/sync-attempt.entity';
import { OrderService } from '../orders/order.service';
import { isRetryableError, computeExponentialBackoffSeconds } from './sync-retry.service';

function extractFirstRow<T = any>(queryResult: any): T {
  const rows =
    Array.isArray(queryResult) && Array.isArray(queryResult[0])
      ? queryResult[0]
      : Array.isArray(queryResult)
        ? queryResult
        : [queryResult];
  return rows[0];
}

@Injectable()
export class SyncService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly orderService: OrderService,
  ) {}

  /**
   * Orchestrates inbound webhook synchronization across the 3-phase transaction sequence.
   */
  async handleInboundWebhook(
    tenantId: string,
    source: string,
    externalId: string,
    payload: any,
  ): Promise<{ status: number; syncLog: SyncLog; order?: any }> {
    const normalizedSource = source.toLowerCase().trim();
    const cleanExternalId = externalId.trim();

    // --------------------------------------------------------------------------
    // Phase A.1 — Ingestion Transaction (Ingestion TX)
    // --------------------------------------------------------------------------
    let syncLogId: string;
    let existingStateResult: { status: number; syncLog: SyncLog } | null = null;

    const ingestQr = this.dataSource.createQueryRunner();
    await ingestQr.connect();
    await ingestQr.startTransaction();

    try {
      await ingestQr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const existingRows = await ingestQr.query(
        `
        SELECT * FROM sync_logs
        WHERE tenant_id = $1 AND lower(source) = $2 AND external_id = $3
        FOR UPDATE;
        `,
        [tenantId, normalizedSource, cleanExternalId],
      );
      const existing = extractFirstRow<SyncLog>(existingRows);

      if (existing) {
        if (existing.status === SyncStatus.SUCCEEDED) {
          existingStateResult = { status: 200, syncLog: existing };
        } else if (
          existing.status === SyncStatus.PENDING ||
          existing.status === SyncStatus.PROCESSING ||
          existing.status === SyncStatus.RETRY_SCHEDULED
        ) {
          existingStateResult = { status: 202, syncLog: existing };
        } else if (existing.status === SyncStatus.FAILED_PERMANENT) {
          await ingestQr.commitTransaction();
          throw new ConflictException({
            statusCode: 409,
            error_code: existing.last_error_code || 'SYNC_FAILED_PERMANENT',
            message: existing.last_error_message || 'Permanent failure previously recorded',
            sync_log_id: existing.id,
          });
        }
      }

      if (!existingStateResult) {
        // Insert new PENDING SyncLog with attempt_count = 0
        const newLog = ingestQr.manager.create(SyncLog, {
          tenant_id: tenantId,
          source: normalizedSource,
          external_id: cleanExternalId,
          event_type: 'ORDER_CREATE',
          status: SyncStatus.PENDING,
          attempt_count: 0,
          max_attempts: 5,
          payload: payload || {},
        });

        const saved = await ingestQr.manager.save(SyncLog, newLog);
        syncLogId = saved.id;
      } else {
        syncLogId = existingStateResult.syncLog.id;
      }

      await ingestQr.commitTransaction();
    } catch (err) {
      if (ingestQr.isTransactionActive) {
        await ingestQr.rollbackTransaction();
      }
      throw err;
    } finally {
      await ingestQr.release();
    }

    if (existingStateResult) {
      return existingStateResult;
    }

    // --------------------------------------------------------------------------
    // Phase A.2 — Claim Transaction (Claim TX)
    // --------------------------------------------------------------------------
    const claimQr = this.dataSource.createQueryRunner();
    await claimQr.connect();
    await claimQr.startTransaction();

    let claimedLeaseToken = randomUUID();
    let claimSuccess = false;
    let claimedLog: any = null;

    try {
      await claimQr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const lockedLogRows = await claimQr.query(
        `SELECT * FROM sync_logs WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
        [tenantId, syncLogId],
      );
      const lockedLog = extractFirstRow(lockedLogRows);

      if (!lockedLog || lockedLog.status !== SyncStatus.PENDING) {
        // Another worker claimed it
        await claimQr.commitTransaction();
        return { status: 202, syncLog: lockedLog };
      }

      // Transition to PROCESSING, increment attempt_count = 1
      await claimQr.query(
        `
        UPDATE sync_logs
        SET status = 'PROCESSING',
            attempt_count = 1,
            lease_token = $1,
            lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '60 seconds',
            processing_started_at = CURRENT_TIMESTAMP,
            active_trigger_source = 'WEBHOOK',
            next_retry_at = NULL,
            next_trigger_source = NULL,
            last_attempted_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $2 AND id = $3;
        `,
        [claimedLeaseToken, tenantId, syncLogId],
      );

      claimedLog = {
        ...lockedLog,
        status: SyncStatus.PROCESSING,
        attempt_count: 1,
        lease_token: claimedLeaseToken,
        active_trigger_source: 'WEBHOOK',
      };

      await claimQr.commitTransaction();
      claimSuccess = true;
    } catch (err) {
      if (claimQr.isTransactionActive) {
        await claimQr.rollbackTransaction();
      }
      throw err;
    } finally {
      await claimQr.release();
    }

    if (!claimSuccess) {
      return { status: 202, syncLog: claimedLog };
    }

    // --------------------------------------------------------------------------
    // Phase B — Domain Execution Transaction (Domain TX)
    // --------------------------------------------------------------------------
    const startTime = Date.now();
    const domainQr = this.dataSource.createQueryRunner();
    await domainQr.connect();
    await domainQr.startTransaction();

    let domainSucceeded = false;
    let createdOrder: any = null;
    let domainError: any = null;
    let updatedSyncLog: any = null;

    try {
      await domainQr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const logRows = await domainQr.query(
        `SELECT * FROM sync_logs WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
        [tenantId, syncLogId],
      );
      const log = extractFirstRow(logRows);

      if (
        !log ||
        log.status !== SyncStatus.PROCESSING ||
        log.lease_token !== claimedLeaseToken
      ) {
        throw new Error('Lost processing lease before domain execution');
      }

      // Execute order creation
      const parsedPayload = typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload;
      createdOrder = await this.orderService.create(tenantId, null, {
        customer_id: parsedPayload.customer_id,
        auto_allocate: true,
        items: parsedPayload.items,
      });

      // Insert SUCCEEDED SyncAttempt
      const durationMs = Date.now() - startTime;
      const attempt = domainQr.manager.create(SyncAttempt, {
        tenant_id: tenantId,
        sync_log_id: syncLogId,
        attempt_number: 1,
        lease_token: claimedLeaseToken,
        trigger_source: SyncTriggerSource.WEBHOOK,
        status: SyncAttemptStatus.SUCCEEDED,
        pg_sqlstate: null,
        http_status: null,
        error_code: null,
        error_message: null,
        started_at: new Date(startTime),
        finished_at: new Date(),
        duration_ms: durationMs,
      });
      await domainQr.manager.save(SyncAttempt, attempt);

      // Update SyncLog to SUCCEEDED
      await domainQr.query(
        `
        UPDATE sync_logs
        SET status = 'SUCCEEDED',
            order_id = $1,
            completed_at = CURRENT_TIMESTAMP,
            processing_started_at = NULL,
            lease_expires_at = NULL,
            lease_token = NULL,
            active_trigger_source = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $2 AND id = $3;
        `,
        [createdOrder.id, tenantId, syncLogId],
      );

      const refreshed = await domainQr.manager.findOne(SyncLog, {
        where: { tenant_id: tenantId, id: syncLogId },
      });
      updatedSyncLog = refreshed;

      await domainQr.commitTransaction();
      domainSucceeded = true;
    } catch (err) {
      domainError = err;
      if (domainQr.isTransactionActive) {
        await domainQr.rollbackTransaction();
      }
    } finally {
      await domainQr.release();
    }

    if (domainSucceeded) {
      return { status: 201, syncLog: updatedSyncLog, order: createdOrder };
    }

    // --------------------------------------------------------------------------
    // Phase C — Failure Persistence Transaction (Failure TX)
    // --------------------------------------------------------------------------
    const failQr = this.dataSource.createQueryRunner();
    await failQr.connect();
    await failQr.startTransaction();

    let finalSyncLog: any = null;
    let isRetryable = false;
    let errorCode = 'SYNC_FAILED';
    let errorMessage = 'Domain execution failed';

    try {
      await failQr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const logRows = await failQr.query(
        `SELECT * FROM sync_logs WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
        [tenantId, syncLogId],
      );
      const log = extractFirstRow(logRows);

      if (
        log &&
        log.status === SyncStatus.PROCESSING &&
        log.lease_token === claimedLeaseToken
      ) {
        const durationMs = Date.now() - startTime;
        isRetryable = isRetryableError(domainError);
        errorCode =
          domainError?.response?.error_code ||
          domainError?.error_code ||
          (isRetryable ? 'DB_LOCK_TIMEOUT' : 'DOMAIN_FAILURE');
        errorMessage = domainError?.message || 'Sync processing failed';
        const pgSqlstate = domainError?.code || null;
        const httpStatus = domainError?.status || domainError?.response?.statusCode || null;

        if (isRetryable) {
          const delaySec = computeExponentialBackoffSeconds(1);

          const attempt = failQr.manager.create(SyncAttempt, {
            tenant_id: tenantId,
            sync_log_id: syncLogId,
            attempt_number: 1,
            lease_token: claimedLeaseToken,
            trigger_source: SyncTriggerSource.WEBHOOK,
            status: SyncAttemptStatus.FAILED_RETRYABLE,
            pg_sqlstate: pgSqlstate,
            http_status: httpStatus,
            error_code: errorCode,
            error_message: errorMessage,
            started_at: new Date(startTime),
            finished_at: new Date(),
            duration_ms: durationMs,
          });
          await failQr.manager.save(SyncAttempt, attempt);

          await failQr.query(
            `
            UPDATE sync_logs
            SET status = 'RETRY_SCHEDULED',
                next_retry_at = CURRENT_TIMESTAMP + ($1 || ' seconds')::INTERVAL,
                next_trigger_source = 'AUTO_RETRY',
                last_pg_sqlstate = $2,
                last_http_status = $3,
                last_error_code = $4,
                last_error_message = $5,
                processing_started_at = NULL,
                lease_expires_at = NULL,
                lease_token = NULL,
                active_trigger_source = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = $6 AND id = $7;
            `,
            [delaySec, pgSqlstate, httpStatus, errorCode, errorMessage, tenantId, syncLogId],
          );
        } else {
          // Permanent failure
          const attempt = failQr.manager.create(SyncAttempt, {
            tenant_id: tenantId,
            sync_log_id: syncLogId,
            attempt_number: 1,
            lease_token: claimedLeaseToken,
            trigger_source: SyncTriggerSource.WEBHOOK,
            status: SyncAttemptStatus.FAILED_PERMANENT,
            pg_sqlstate: pgSqlstate,
            http_status: httpStatus,
            error_code: errorCode,
            error_message: errorMessage,
            started_at: new Date(startTime),
            finished_at: new Date(),
            duration_ms: durationMs,
          });
          await failQr.manager.save(SyncAttempt, attempt);

          await failQr.query(
            `
            UPDATE sync_logs
            SET status = 'FAILED_PERMANENT',
                next_retry_at = NULL,
                next_trigger_source = NULL,
                last_pg_sqlstate = $1,
                last_http_status = $2,
                last_error_code = $3,
                last_error_message = $4,
                processing_started_at = NULL,
                lease_expires_at = NULL,
                lease_token = NULL,
                active_trigger_source = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = $5 AND id = $6;
            `,
            [pgSqlstate, httpStatus, errorCode, errorMessage, tenantId, syncLogId],
          );
        }

        finalSyncLog = await failQr.manager.findOne(SyncLog, {
          where: { tenant_id: tenantId, id: syncLogId },
        });
      }

      await failQr.commitTransaction();
    } catch (err) {
      if (failQr.isTransactionActive) {
        await failQr.rollbackTransaction();
      }
      throw err;
    } finally {
      await failQr.release();
    }

    if (isRetryable) {
      return { status: 202, syncLog: finalSyncLog };
    }

    // Re-throw permanent failure with original status
    if (domainError instanceof ConflictException) {
      throw domainError;
    }
    if (domainError instanceof BadRequestException) {
      throw domainError;
    }
    if (domainError instanceof NotFoundException) {
      throw domainError;
    }

    throw new ConflictException({
      statusCode: 409,
      error_code: errorCode,
      message: errorMessage,
      sync_log_id: syncLogId,
    });
  }
}
