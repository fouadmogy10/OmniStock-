import { Injectable, ConflictException, NotFoundException, Optional, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { SyncLog, SyncStatus } from './entities/sync-log.entity';
import { SyncAttempt, SyncAttemptStatus, SyncTriggerSource } from './entities/sync-attempt.entity';
import { OrderService } from '../orders/order.service';
import { AuditLogService } from '../audit/audit.service';
import { FindSyncLogsQuery } from './dto/sync.dto';
import { Tenant } from '../tenant/entities/tenant.entity';
import { ShutdownDrainService } from '../../common/services/shutdown-drain.service';

function extractFirstRow<T = any>(queryResult: any): T {
  const rows =
    Array.isArray(queryResult) && Array.isArray(queryResult[0])
      ? queryResult[0]
      : Array.isArray(queryResult)
        ? queryResult
        : [queryResult];
  return rows[0];
}

export function computeExponentialBackoffSeconds(attemptNumber: number): number {
  // delay = min(30 * 2^(attemptNumber - 1), 3600)
  const power = Math.max(0, attemptNumber - 1);
  const seconds = 30 * Math.pow(2, power);
  return Math.min(seconds, 3600);
}

export function isRetryableError(err: any): boolean {
  if (!err) return false;
  const sqlState = err.code || err.pg_sqlstate;
  if (
    sqlState === '40P01' || // deadlock_detected
    sqlState === '55P03' || // lock_not_available
    sqlState === '57014' || // query_canceled (timeout)
    sqlState === '40001' || // serialization_failure
    sqlState === '08006' || // connection_failure
    sqlState === '08001' || // sqlclient_unable_to_establish_sqlconnection
    sqlState === '57P01' // admin_shutdown
  ) {
    return true;
  }
  return false;
}

@Injectable()
export class SyncRetryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly orderService: OrderService,
    private readonly auditLogService: AuditLogService,
    @Optional()
    @Inject(ShutdownDrainService)
    private readonly shutdownDrainService?: ShutdownDrainService,
  ) {}

  /**
   * Recovers expired PROCESSING leases across active tenants (F7-5).
   * Inserts FAILED_RETRYABLE SyncAttempt without incrementing attempt_count.
   */
  async recoverExpiredLeases(): Promise<number> {
    const tenants = await this.dataSource.manager.find(Tenant, {
      where: { is_active: true },
      order: { id: 'ASC' },
    });

    let totalRecovered = 0;

    for (const tenant of tenants) {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();

      try {
        await qr.query(`SET LOCAL app.current_tenant_id = '${tenant.id}';`);

        const expiredLogs: any[] = await qr.query(
          `
          SELECT * FROM sync_logs
          WHERE status = 'PROCESSING' AND lease_expires_at <= CURRENT_TIMESTAMP
          ORDER BY lease_expires_at ASC, id ASC
          LIMIT 25
          FOR UPDATE SKIP LOCKED;
          `,
        );

        for (const row of expiredLogs) {
          const attemptCount = Number(row.attempt_count);
          const maxAttempts = Number(row.max_attempts);
          const startedAt = row.processing_started_at
            ? new Date(row.processing_started_at)
            : new Date();
          const finishedAt = new Date();
          const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

          // Insert append-only SyncAttempt without incrementing attempt_count
          const attempt = qr.manager.create(SyncAttempt, {
            tenant_id: tenant.id,
            sync_log_id: row.id,
            attempt_number: attemptCount,
            lease_token: row.lease_token || randomUUID(),
            trigger_source: row.active_trigger_source || SyncTriggerSource.AUTO_RETRY,
            status: SyncAttemptStatus.FAILED_RETRYABLE,
            pg_sqlstate: null,
            http_status: null,
            error_code: 'PROCESSING_LEASE_EXPIRED',
            error_message: 'Worker processing lease expired before completion',
            started_at: startedAt,
            finished_at: finishedAt,
            duration_ms: durationMs,
          });
          await qr.manager.save(SyncAttempt, attempt);

          if (attemptCount < maxAttempts) {
            const delaySec = computeExponentialBackoffSeconds(attemptCount);
            await qr.query(
              `
              UPDATE sync_logs
              SET status = 'RETRY_SCHEDULED',
                  next_retry_at = CURRENT_TIMESTAMP + ($1 || ' seconds')::INTERVAL,
                  next_trigger_source = 'AUTO_RETRY',
                  last_error_code = 'PROCESSING_LEASE_EXPIRED',
                  last_error_message = 'Worker processing lease expired before completion',
                  processing_started_at = NULL,
                  lease_expires_at = NULL,
                  lease_token = NULL,
                  active_trigger_source = NULL,
                  updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id = $2 AND id = $3;
              `,
              [delaySec, tenant.id, row.id],
            );
          } else {
            await qr.query(
              `
              UPDATE sync_logs
              SET status = 'FAILED_PERMANENT',
                  next_retry_at = NULL,
                  next_trigger_source = NULL,
                  last_error_code = 'MAX_RETRIES_EXHAUSTED',
                  last_error_message = 'Maximum synchronization attempts (5) exhausted after processing lease expiry',
                  processing_started_at = NULL,
                  lease_expires_at = NULL,
                  lease_token = NULL,
                  active_trigger_source = NULL,
                  updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id = $2 AND id = $3;
              `,
              [tenant.id, row.id],
            );
          }
          totalRecovered++;
        }

        await qr.commitTransaction();
      } catch (err) {
        await qr.rollbackTransaction();
      } finally {
        await qr.release();
      }
    }

    return totalRecovered;
  }

  /**
   * Claims and processes the next due PENDING or RETRY_SCHEDULED event across active tenants.
   */
  async claimAndProcessNextDueEvent(): Promise<boolean> {
    const tenants = await this.dataSource.manager.find(Tenant, {
      where: { is_active: true },
      order: { id: 'ASC' },
    });

    for (const tenant of tenants) {
      // Phase A: Claim TX
      const claimQr = this.dataSource.createQueryRunner();
      await claimQr.connect();
      await claimQr.startTransaction();

      let claimedLog: any = null;
      const claimedLeaseToken = randomUUID();

      try {
        await claimQr.query(`SET LOCAL app.current_tenant_id = '${tenant.id}';`);

        const candidateRows: any[] = await claimQr.query(
          `
          SELECT * FROM sync_logs
          WHERE (status = 'PENDING' OR (status = 'RETRY_SCHEDULED' AND next_retry_at <= CURRENT_TIMESTAMP))
            AND attempt_count < max_attempts
          ORDER BY COALESCE(next_retry_at, created_at) ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED;
          `,
        );

        const row = extractFirstRow(candidateRows);
        if (row) {
          const newAttemptCount = Number(row.attempt_count) + 1;
          const activeTrigger = row.next_trigger_source || SyncTriggerSource.AUTO_RETRY;

          await claimQr.query(
            `
            UPDATE sync_logs
            SET status = 'PROCESSING',
                attempt_count = $1,
                lease_token = $2,
                lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '60 seconds',
                processing_started_at = CURRENT_TIMESTAMP,
                active_trigger_source = $3,
                next_retry_at = NULL,
                next_trigger_source = NULL,
                last_attempted_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = $4 AND id = $5;
            `,
            [newAttemptCount, claimedLeaseToken, activeTrigger, tenant.id, row.id],
          );

          claimedLog = {
            ...row,
            attempt_count: newAttemptCount,
            lease_token: claimedLeaseToken,
            active_trigger_source: activeTrigger,
          };
        }

        await claimQr.commitTransaction();
      } catch (err) {
        await claimQr.rollbackTransaction();
      } finally {
        await claimQr.release();
      }

      if (!claimedLog) {
        continue;
      }

      this.shutdownDrainService?.startWorkerJob(claimedLog.id, 'Phase A.2 — Claim TX');

      // Execute Phase B & Phase C
      await this.executeDomainAndFailureTransactions(tenant.id, claimedLog, claimedLeaseToken);
      return true; // Claimed and processed one event
    }

    return false;
  }

  /**
   * Executes Phase B (Domain TX) and if needed Phase C (Failure TX).
   */
  async executeDomainAndFailureTransactions(
    tenantId: string,
    claimedLog: any,
    claimedLeaseToken: string,
  ): Promise<void> {
    const startTime = Date.now();
    let domainSucceeded = false;

    try {
      this.shutdownDrainService?.updateWorkerJobPhase(claimedLog.id, 'Phase B — Domain TX');

      // Phase B — Domain Transaction
      const domainQr = this.dataSource.createQueryRunner();
      await domainQr.connect();
      await domainQr.startTransaction();

      let domainError: any = null;

      try {
        await domainQr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

        // Verify lease
        const lockedLogRows = await domainQr.query(
          `SELECT * FROM sync_logs WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
          [tenantId, claimedLog.id],
        );
        const lockedLog = extractFirstRow(lockedLogRows);

        if (
          !lockedLog ||
          lockedLog.status !== SyncStatus.PROCESSING ||
          lockedLog.lease_token !== claimedLeaseToken
        ) {
          throw new Error('Lost processing lease before domain execution');
        }

        // Execute OrderService.create
        const payload =
          typeof lockedLog.payload === 'string' ? JSON.parse(lockedLog.payload) : lockedLog.payload;
        const order = await this.orderService.create(tenantId, null, {
          customer_id: payload.customer_id,
          auto_allocate: true,
          items: payload.items,
        });

        // Insert SUCCEEDED SyncAttempt
        const durationMs = Date.now() - startTime;
        const attempt = domainQr.manager.create(SyncAttempt, {
          tenant_id: tenantId,
          sync_log_id: lockedLog.id,
          attempt_number: Number(lockedLog.attempt_count),
          lease_token: claimedLeaseToken,
          trigger_source: lockedLog.active_trigger_source || SyncTriggerSource.AUTO_RETRY,
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
            next_retry_at = NULL,
            next_trigger_source = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $2 AND id = $3;
        `,
          [order.id, tenantId, lockedLog.id],
        );

        await domainQr.commitTransaction();
        domainSucceeded = true;
      } catch (err) {
        domainError = err;
        await domainQr.rollbackTransaction();
      } finally {
        await domainQr.release();
      }

      if (domainSucceeded) {
        return;
      }

      this.shutdownDrainService?.updateWorkerJobPhase(claimedLog.id, 'Phase C — Failure TX');

      // Phase C — Failure Transaction
      const failQr = this.dataSource.createQueryRunner();
      await failQr.connect();
      await failQr.startTransaction();

      try {
        await failQr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

        const lockedLogRows = await failQr.query(
          `SELECT * FROM sync_logs WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
          [tenantId, claimedLog.id],
        );
        const lockedLog = extractFirstRow(lockedLogRows);

        if (
          lockedLog &&
          lockedLog.status === SyncStatus.PROCESSING &&
          lockedLog.lease_token === claimedLeaseToken
        ) {
          const durationMs = Date.now() - startTime;
          const attemptCount = Number(lockedLog.attempt_count);
          const maxAttempts = Number(lockedLog.max_attempts);
          const isRetryable = isRetryableError(domainError);
          const errorCode =
            domainError?.response?.error_code ||
            domainError?.error_code ||
            (isRetryable ? 'DB_LOCK_TIMEOUT' : 'DOMAIN_FAILURE');
          const errorMessage = domainError?.message || 'Sync processing failed';
          const pgSqlstate = domainError?.code || null;
          const httpStatus = domainError?.status || domainError?.response?.statusCode || null;

          if (isRetryable && attemptCount < maxAttempts) {
            const delaySec = computeExponentialBackoffSeconds(attemptCount);

            const attempt = failQr.manager.create(SyncAttempt, {
              tenant_id: tenantId,
              sync_log_id: lockedLog.id,
              attempt_number: attemptCount,
              lease_token: claimedLeaseToken,
              trigger_source: lockedLog.active_trigger_source || SyncTriggerSource.AUTO_RETRY,
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
              [delaySec, pgSqlstate, httpStatus, errorCode, errorMessage, tenantId, lockedLog.id],
            );
          } else {
            // Permanent failure or max attempts exhausted
            const finalErrorCode =
              isRetryable && attemptCount >= maxAttempts ? 'MAX_RETRIES_EXHAUSTED' : errorCode;

            const attempt = failQr.manager.create(SyncAttempt, {
              tenant_id: tenantId,
              sync_log_id: lockedLog.id,
              attempt_number: attemptCount,
              lease_token: claimedLeaseToken,
              trigger_source: lockedLog.active_trigger_source || SyncTriggerSource.AUTO_RETRY,
              status: SyncAttemptStatus.FAILED_PERMANENT,
              pg_sqlstate: pgSqlstate,
              http_status: httpStatus,
              error_code: finalErrorCode,
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
              [pgSqlstate, httpStatus, finalErrorCode, errorMessage, tenantId, lockedLog.id],
            );
          }
        }

        await failQr.commitTransaction();
      } catch (err) {
        await failQr.rollbackTransaction();
      } finally {
        await failQr.release();
      }
    } finally {
      this.shutdownDrainService?.finishWorkerJob(claimedLog.id);
    }
  }

  async retrySyncLog(tenantId: string, actorUserId: string, id: string): Promise<SyncLog> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const logRows = await qr.query(
        `SELECT * FROM sync_logs WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
        [tenantId, id],
      );
      const row = extractFirstRow(logRows);

      if (!row) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'SYNC_LOG_NOT_FOUND',
          message: `SyncLog ${id} not found in this tenant`,
        });
      }

      if (row.status !== SyncStatus.RETRY_SCHEDULED) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_SYNC_RETRY_STATE',
          message: `Cannot manually retry SyncLog in status ${row.status}. Only RETRY_SCHEDULED logs can be accelerated`,
        });
      }

      const attemptCount = Number(row.attempt_count);
      const maxAttempts = Number(row.max_attempts);

      if (attemptCount >= maxAttempts) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_SYNC_RETRY_STATE',
          message: `Maximum synchronization attempts (${maxAttempts}) reached for this log`,
        });
      }

      // Schedule acceleration: next_retry_at = CURRENT_TIMESTAMP, next_trigger_source = 'MANUAL_RETRY'
      // Does NOT increment attempt_count and does NOT execute domain logic in the HTTP request.
      await qr.query(
        `
        UPDATE sync_logs
        SET next_retry_at = CURRENT_TIMESTAMP,
            next_trigger_source = 'MANUAL_RETRY',
            updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND id = $2;
        `,
        [tenantId, id],
      );

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'SYNC_MANUAL_RETRY',
          entityType: 'SyncLog',
          entityId: id,
          metadata: {
            attempt_count: attemptCount,
            source: row.source,
            external_id: row.external_id,
          },
        },
        qr.manager,
      );

      await qr.commitTransaction();

      return await this.getSyncLogById(tenantId, id);
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getSyncLogs(
    tenantId: string,
    query: FindSyncLogsQuery,
  ): Promise<{ data: SyncLog[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = (page - 1) * limit;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const qb = qr.manager
        .createQueryBuilder(SyncLog, 'sl')
        .where('sl.tenant_id = :tenantId', { tenantId });

      if (query.status) {
        qb.andWhere('sl.status = :status', { status: query.status });
      }

      if (query.source) {
        qb.andWhere('lower(sl.source) = lower(:source)', { source: query.source.trim() });
      }

      if (query.external_id) {
        qb.andWhere('sl.external_id = :externalId', { externalId: query.external_id.trim() });
      }

      if (query.from) {
        qb.andWhere('sl.created_at >= :from', { from: new Date(query.from) });
      }

      if (query.to) {
        qb.andWhere('sl.created_at <= :to', { to: new Date(query.to) });
      }

      qb.orderBy('sl.created_at', 'DESC').addOrderBy('sl.id', 'DESC');
      qb.skip(offset).take(limit);

      const [data, total] = await qb.getManyAndCount();
      await qr.commitTransaction();

      return { data, total, page, limit };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getSyncLogById(tenantId: string, id: string): Promise<SyncLog> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const log = await qr.manager.findOne(SyncLog, {
        where: { tenant_id: tenantId, id },
      });

      if (!log) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'SYNC_LOG_NOT_FOUND',
          message: `SyncLog ${id} not found in this tenant`,
        });
      }

      const attempts = await qr.manager.find(SyncAttempt, {
        where: { tenant_id: tenantId, sync_log_id: id },
        order: { started_at: 'ASC' },
      });

      log.attempts = attempts;

      await qr.commitTransaction();
      return log;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
