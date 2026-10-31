import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderAllocation } from './entities/order-allocation.entity';
import { OrderService } from './order.service';
import { AllocationService } from './allocation.service';
import { OrderController } from './order.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, OrderAllocation]),
    InventoryModule,
    AuditModule,
  ],
  controllers: [OrderController],
  providers: [OrderService, AllocationService],
  exports: [OrderService, AllocationService],
})
export class OrdersModule {}
