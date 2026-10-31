import {
  Injectable,
  Logger,
  BeforeApplicationShutdown,
  OnApplicationShutdown,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class ShutdownDrainService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownDrainService.name);

  private _isShuttingDown = false;
  private readonly activeRequests = new Set<Promise<any>>();
  private readonly activeWorkerJobs = new Map<string, { startedAt: Date; phase: string }>();

  constructor(private readonly dataSource?: DataSource) {}

  get isShuttingDown(): boolean {
    return this._isShuttingDown;
  }

  setShuttingDown(val: boolean): void {
    this._isShuttingDown = val;
  }

  trackHttpRequest<T>(promise: Promise<T>): Promise<T> {
    this.activeRequests.add(promise);
    const cleanup = () => {
      this.activeRequests.delete(promise);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  startWorkerJob(jobId: string, phase: string = 'Phase A'): void {
    this.activeWorkerJobs.set(jobId, { startedAt: new Date(), phase });
  }

  updateWorkerJobPhase(jobId: string, phase: string): void {
    const job = this.activeWorkerJobs.get(jobId);
    if (job) {
      job.phase = phase;
    }
  }

  finishWorkerJob(jobId: string): void {
    this.activeWorkerJobs.delete(jobId);
  }

  getActiveRequestCount(): number {
    return this.activeRequests.size;
  }

  getActiveJobCount(): number {
    return this.activeWorkerJobs.size;
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.warn(
      `Shutdown signal received (${signal || 'SIGTERM'}). Transitioning readiness to not_ready...`,
    );
    this._isShuttingDown = true;

    const timeoutMs = parseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || '15000', 10);
    const startTime = Date.now();

    this.logger.log(
      `Draining in-flight operations (active HTTP requests: ${this.activeRequests.size}, active worker jobs: ${this.activeWorkerJobs.size}) with timeout ${timeoutMs}ms...`,
    );

    while (this.activeRequests.size > 0 || this.activeWorkerJobs.size > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        this.logger.warn(
          `Shutdown drain timeout expired after ${timeoutMs}ms. Unfinished operations remaining: ` +
            `${this.activeRequests.size} HTTP requests, ${this.activeWorkerJobs.size} worker jobs. Continuing shutdown without silently marking jobs completed.`,
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.logger.log('In-flight drain phase completed.');
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing TypeORM database connection pool on application shutdown...');
    if (this.dataSource && this.dataSource.isInitialized) {
      await this.dataSource.destroy();
      this.logger.log('TypeORM DataSource connection pool closed cleanly.');
    }
  }
}
