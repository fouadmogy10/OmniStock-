import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { AuditLogService } from './audit.service';
import { AuditLogRepository } from './repositories/audit-log.repository';
import { AuditController } from './audit.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  controllers: [AuditController],
  providers: [AuditLogService, AuditLogRepository],
  exports: [AuditLogService, AuditLogRepository, TypeOrmModule],
})
export class AuditModule {}
