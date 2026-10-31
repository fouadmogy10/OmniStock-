import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Controller, Get } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { AppModule } from '../../src/app.module';
import { Public } from '../../src/common/decorators/public.decorator';
import { ShutdownDrainService } from '../../src/common/services/shutdown-drain.service';
import { ShutdownDrainInterceptor } from '../../src/common/interceptors/shutdown-drain.interceptor';
import { HealthService } from '../../src/modules/health/health.service';
import { SyncRetryService } from '../../src/modules/sync/sync-retry.service';
import { SyncRetryWorker } from '../../src/modules/sync/sync-retry.worker';
import { SyncLog, SyncStatus } from '../../src/modules/sync/entities/sync-log.entity';
import {
  SyncAttempt,
  SyncAttemptStatus,
} from '../../src/modules/sync/entities/sync-attempt.entity';
import { Tenant } from '../../src/modules/tenant/entities/tenant.entity';

@Controller('test-shutdown')
class TestShutdownController {
  @Public()
  @Get('slow')
  async slow(): Promise<{ ok: boolean }> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ok: true };
  }

  @Public()
  @Get('fast')
  fast(): { ok: boolean } {
    return { ok: true };
  }
}

describe('Operational Graceful Shutdown & Drain Verification', () => {
  let app: INestApplication;
  let shutdownDrainService: ShutdownDrainService;
  let healthService: HealthService;
  let syncRetryService: SyncRetryService;
  let syncRetryWorker: SyncRetryWorker;
  let dataSource: DataSource;

  beforeAll(async () => {
    process.env.SHUTDOWN_DRAIN_TIMEOUT_MS = '2000';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestShutdownController],
    }).compile();

    app = moduleFixture.createNestApplication();
    shutdownDrainService = app.get(ShutdownDrainService);
    app.useGlobalInterceptors(new ShutdownDrainInterceptor(shutdownDrainService));
    await app.init();

    shutdownDrainService = app.get(ShutdownDrainService);
    healthService = app.get(HealthService);
    syncRetryService = app.get(SyncRetryService);
    syncRetryWorker = app.get(SyncRetryWorker);
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    shutdownDrainService.setShuttingDown(false);
  });

  describe('1. In-flight HTTP request tracking & rejection during shutdown', () => {
    it('tracks active in-flight requests, rejects new incoming requests with 503, and fails readiness', async () => {
      // 1. Initial health readiness check returns 200 ready
      const readyBefore = await healthService.getReady();
      expect(readyBefore.status).toBe('ready');

      // 2. Start a slow in-flight request using .end() to immediately dispatch HTTP request
      const slowRequestPromise = new Promise<request.Response>((resolve, reject) => {
        request(app.getHttpServer())
          .get('/test-shutdown/slow')
          .end((err, res) => {
            if (err) reject(err);
            else resolve(res);
          });
      });

      // Wait a moment for interceptor to register request
      await new Promise((r) => setTimeout(r, 60));
      expect(shutdownDrainService.getActiveRequestCount()).toBeGreaterThanOrEqual(1);

      // 3. Initiate graceful shutdown
      shutdownDrainService.setShuttingDown(true);

      // 4. Readiness probe immediately fails with 503 SERVER_NOT_READY
      await expect(healthService.getReady()).rejects.toThrow();

      // 5. New requests are rejected with 503 SERVER_SHUTTING_DOWN
      const rejectedRes = await request(app.getHttpServer()).get('/test-shutdown/fast').expect(503);

      expect(rejectedRes.body.error_code).toBe('SERVER_SHUTTING_DOWN');
      expect(rejectedRes.body.statusCode).toBe(503);

      // 6. In-flight request finishes successfully
      const slowRes = await slowRequestPromise;
      expect(slowRes.body.ok).toBe(true);

      // 7. Request count returns to 0
      expect(shutdownDrainService.getActiveRequestCount()).toBe(0);
    });
  });

  describe('2. Multi-phase worker job tracking across complete lifecycle', () => {
    it('tracks worker job through Phase A, B, and C, and shutdown waits for completion', async () => {
      const testJobId = `job-${Date.now()}`;

      // Start job in Phase A.2
      shutdownDrainService.startWorkerJob(testJobId, 'Phase A.2 — Claim TX');
      expect(shutdownDrainService.getActiveJobCount()).toBe(1);

      // Update to Phase B
      shutdownDrainService.updateWorkerJobPhase(testJobId, 'Phase B — Domain TX');
      expect(shutdownDrainService.getActiveJobCount()).toBe(1);

      // Update to Phase C
      shutdownDrainService.updateWorkerJobPhase(testJobId, 'Phase C — Failure TX');
      expect(shutdownDrainService.getActiveJobCount()).toBe(1);

      // Complete job asynchronously after 200ms
      setTimeout(() => {
        shutdownDrainService.finishWorkerJob(testJobId);
      }, 200);

      // beforeApplicationShutdown awaits active worker jobs
      const startDrain = Date.now();
      await shutdownDrainService.beforeApplicationShutdown('SIGTERM');
      const drainDuration = Date.now() - startDrain;

      expect(drainDuration).toBeGreaterThanOrEqual(180);
      expect(shutdownDrainService.getActiveJobCount()).toBe(0);
    });

    it('shutdown drain timeout triggers structured warning without silently marking jobs complete', async () => {
      const stuckJobId = `stuck-job-${Date.now()}`;
      shutdownDrainService.startWorkerJob(stuckJobId, 'Phase B — Domain TX');

      const startDrain = Date.now();
      // Timeout is 2000ms
      await shutdownDrainService.beforeApplicationShutdown('SIGTERM');
      const elapsed = Date.now() - startDrain;

      expect(elapsed).toBeGreaterThanOrEqual(1900);
      // Job remains active in tracking (not silently dropped or marked finished)
      expect(shutdownDrainService.getActiveJobCount()).toBe(1);

      shutdownDrainService.finishWorkerJob(stuckJobId);
    });
  });

  describe('3. DataSource closure on application shutdown', () => {
    it('closes the database connection pool in onApplicationShutdown', async () => {
      expect(dataSource.isInitialized).toBe(true);
      await shutdownDrainService.onApplicationShutdown();
      expect(dataSource.isInitialized).toBe(false);

      // Re-initialize for subsequent tests or cleanup
      await dataSource.initialize();
    });
  });

  describe('4. Interrupted worker job recovery via lease expiry mechanism (F7-5)', () => {
    it('recovers abandoned PROCESSING sync logs whose leases expired during worker interruption', async () => {
      // 1. Create a tenant
      const tenant = await dataSource.manager.save(
        Tenant,
        dataSource.manager.create(Tenant, {
          name: 'Shutdown Recovery Tenant',
          slug: `rec-ten-${Date.now()}`,
          is_active: true,
        }),
      );

      // 2. Create an abandoned SyncLog with lease expired in the past inside tenant context
      const pastDate = new Date(Date.now() - 120 * 1000);
      const insertQr = dataSource.createQueryRunner();
      await insertQr.connect();
      await insertQr.startTransaction();
      await insertQr.query(`SET LOCAL app.current_tenant_id = '${tenant.id}';`);

      const syncLog = insertQr.manager.create(SyncLog, {
        tenant_id: tenant.id,
        source: 'salla',
        external_id: `ABANDONED-${Date.now()}`,
        event_type: 'order.created',
        status: SyncStatus.PROCESSING,
        attempt_count: 1,
        max_attempts: 5,
        payload: { order_id: '123' },
        lease_token: randomUUID(),
        lease_expires_at: pastDate,
        processing_started_at: pastDate,
        active_trigger_source: 'AUTO_RETRY' as any,
      });
      const savedLog = await insertQr.manager.save(SyncLog, syncLog);
      await insertQr.commitTransaction();
      await insertQr.release();

      // 3. Worker executes lease recovery
      const recoveredCount = await syncRetryService.recoverExpiredLeases();
      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      // 4. Verify the abandoned SyncLog was transitioned to RETRY_SCHEDULED inside tenant context
      const checkQr = dataSource.createQueryRunner();
      await checkQr.connect();
      await checkQr.startTransaction();
      await checkQr.query(`SET LOCAL app.current_tenant_id = '${tenant.id}';`);

      const updatedLog = await checkQr.manager.findOne(SyncLog, {
        where: { id: savedLog.id },
      });

      expect(updatedLog).toBeDefined();
      expect(updatedLog!.status).toBe(SyncStatus.RETRY_SCHEDULED);
      expect(updatedLog!.last_error_code).toBe('PROCESSING_LEASE_EXPIRED');
      expect(updatedLog!.lease_token).toBeNull();
      expect(updatedLog!.lease_expires_at).toBeNull();

      // 5. Verify append-only SyncAttempt record was created with FAILED_RETRYABLE
      const attempt = await checkQr.manager.findOne(SyncAttempt, {
        where: { sync_log_id: savedLog.id },
      });

      expect(attempt).toBeDefined();
      expect(attempt!.status).toBe(SyncAttemptStatus.FAILED_RETRYABLE);
      expect(attempt!.error_code).toBe('PROCESSING_LEASE_EXPIRED');

      await checkQr.commitTransaction();
      await checkQr.release();
    });
  });
});
