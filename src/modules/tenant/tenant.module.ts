import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tenant } from './entities/tenant.entity';
import { TenantService } from './tenant.service';
import { TenantController } from './tenant.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([Tenant]), AuditModule],
  controllers: [TenantController],
  providers: [TenantService],
  exports: [TenantService, TypeOrmModule],
})
export class TenantModule {}
