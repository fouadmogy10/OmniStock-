import { Injectable, ServiceUnavailableException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShutdownDrainService } from '../../common/services/shutdown-drain.service';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly shutdownDrainService: ShutdownDrainService,
  ) {}

  getLive(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async getReady(): Promise<{ status: 'ready' }> {
    // 1. If currently shutting down, fail readiness probe immediately
    if (this.shutdownDrainService.isShuttingDown) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error_code: 'SERVER_NOT_READY',
        status: 'not_ready',
        message: 'Server is shutting down',
      });
    }

    // 2. Execute lightweight SELECT 1 over runtime connection pool
    try {
      await this.dataSource.query('SELECT 1;');
      return { status: 'ready' };
    } catch (err: any) {
      this.logger.error('Readiness probe failed database connectivity check', err.message);
      throw new ServiceUnavailableException({
        statusCode: 503,
        error_code: 'DATABASE_UNAVAILABLE',
        status: 'not_ready',
        message: 'Database connection is unavailable',
      });
    }
  }
}
