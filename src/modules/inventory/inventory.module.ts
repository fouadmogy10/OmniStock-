import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryItem } from './entities/inventory-item.entity';
import { LowStockAlert } from './entities/low-stock-alert.entity';
import { StockMovement } from './entities/stock-movement.entity';
import { StockTransfer } from './entities/stock-transfer.entity';
import { StockTransferItem } from './entities/stock-transfer-item.entity';
import { InventoryRepository } from './repositories/inventory.repository';
import { StockMovementRepository } from './repositories/stock-movement.repository';
import { LowStockAlertService } from './low-stock-alert.service';
import { InventoryService } from './inventory.service';
import { StockTransferService } from './stock-transfer.service';
import { InventoryController } from './inventory.controller';
import { StockTransferController } from './stock-transfer.controller';
import { LowStockAlertController } from './low-stock-alert.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InventoryItem,
      LowStockAlert,
      StockMovement,
      StockTransfer,
      StockTransferItem,
    ]),
    AuditModule,
  ],
  providers: [
    InventoryRepository,
    StockMovementRepository,
    LowStockAlertService,
    InventoryService,
    StockTransferService,
  ],
  controllers: [
    InventoryController,
    StockTransferController,
    LowStockAlertController,
  ],
  exports: [
    InventoryRepository,
    StockMovementRepository,
    LowStockAlertService,
    InventoryService,
    StockTransferService,
  ],
})
export class InventoryModule {}

