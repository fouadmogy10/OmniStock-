import { Global, Module } from '@nestjs/common';
import { RateLimiterService } from './services/rate-limiter.service';
import { ShutdownDrainService } from './services/shutdown-drain.service';
import { StructuredLoggerService } from './logging/structured-logger.service';

@Global()
@Module({
  providers: [RateLimiterService, ShutdownDrainService, StructuredLoggerService],
  exports: [RateLimiterService, ShutdownDrainService, StructuredLoggerService],
})
export class CommonModule {}
