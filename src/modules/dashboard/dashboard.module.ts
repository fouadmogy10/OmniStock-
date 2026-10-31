import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { WarehousesModule } from '../warehouses/warehouses.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [WarehousesModule, AuditModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}

