import {
  Injectable,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
  Logger,
} from '@nestjs/common';
import { SyncRetryService } from './sync-retry.service';

@Injectable()
export class SyncRetryWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SyncRetryWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private isTickRunning = false;
  private isShuttingDown = false;

  constructor(private readonly syncRetryService: SyncRetryService) {}

  onApplicationBootstrap(): void {
    const isWorkerEnabled = process.env.SYNC_WORKER_ENABLED !== 'false';
    const intervalMs = parseInt(process.env.SYNC_WORKER_POLL_INTERVAL_MS || '5000', 10);

    if (isWorkerEnabled) {
      this.logger.log(`Starting SyncRetryWorker with interval ${intervalMs}ms`);
      this.timer = setInterval(() => {
        void this.runTick();
      }, intervalMs);
    } else {
      this.logger.log('SyncRetryWorker automatic polling is disabled (SYNC_WORKER_ENABLED=false)');
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.isShuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Deterministic execution tick for background retry polling & lease recovery.
   * Can be invoked directly by tests.
   */
  async runTick(): Promise<void> {
    if (this.isTickRunning || this.isShuttingDown) {
      return;
    }

    this.isTickRunning = true;
    try {
      // 1. Recover expired leases
      await this.syncRetryService.recoverExpiredLeases();

      // 2. Claim and process due events
      let hasMore = true;
      let iterations = 0;
      const maxIterations = parseInt(process.env.SYNC_WORKER_BATCH_SIZE || '10', 10);

      while (hasMore && iterations < maxIterations && !this.isShuttingDown) {
        hasMore = await this.syncRetryService.claimAndProcessNextDueEvent();
        iterations++;
      }
    } catch (err: any) {
      this.logger.error(`Error during SyncRetryWorker tick: ${err.message}`);
    } finally {
      this.isTickRunning = false;
    }
  }
}
