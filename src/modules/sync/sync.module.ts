import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncWebhookCredential } from './entities/sync-webhook-credential.entity';
import { SyncLog } from './entities/sync-log.entity';
import { SyncAttempt } from './entities/sync-attempt.entity';
import { SyncCredentialService } from './sync-credential.service';
import { SyncService } from './sync.service';
import { SyncRetryService } from './sync-retry.service';
import { SyncRetryWorker } from './sync-retry.worker';
import { SyncController } from './sync.controller';
import { WebhookSignatureGuard } from '../../common/guards/webhook-signature.guard';
import { OrdersModule } from '../orders/orders.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncWebhookCredential, SyncLog, SyncAttempt]),
    OrdersModule,
    AuditModule,
  ],
  controllers: [SyncController],
  providers: [
    SyncCredentialService,
    SyncService,
    SyncRetryService,
    SyncRetryWorker,
    WebhookSignatureGuard,
  ],
  exports: [
    SyncCredentialService,
    SyncService,
    SyncRetryService,
    SyncRetryWorker,
  ],
})
export class SyncModule {}

