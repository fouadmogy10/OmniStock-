import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InventoryItem } from './entities/inventory-item.entity';
import { StockMovement, StockMovementType } from './entities/stock-movement.entity';
import { LowStockAlertService } from './low-stock-alert.service';
import { AuditLogService } from '../audit/audit.service';
import { InventoryRepository, FindInventoryLevelsQuery } from './repositories/inventory.repository';
import {
  StockMovementRepository,
  FindMovementsQuery,
} from './repositories/stock-movement.repository';
import { AdjustStockDto } from './dto/inventory.dto';

@Injectable()
export class InventoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly inventoryRepo: InventoryRepository,
    private readonly stockMovementRepo: StockMovementRepository,
    private readonly lowStockAlertService: LowStockAlertService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async adjustStock(tenantId: string, actorUserId: string, dto: AdjustStockDto): Promise<any> {
    if (dto.delta === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error_code: 'VALIDATION_ERROR',
        message: 'Stock adjustment delta cannot be 0',
      });
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      // 1. Verify product exists and is NOT a variant parent container
      const [product] = await qr.query(
        `SELECT id, is_variant_parent FROM products WHERE tenant_id = $1 AND id = $2;`,
        [tenantId, dto.product_id],
      );

      if (!product) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'PRODUCT_NOT_FOUND',
          message: 'Product not found in this tenant',
        });
      }

      if (product.is_variant_parent) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VARIANT_PARENT_NOT_SELLABLE',
          message: 'Variant parent container cannot hold inventory or be adjusted',
        });
      }

      // 2. Verify warehouse exists
      const [warehouse] = await qr.query(
        `SELECT id, is_active FROM warehouses WHERE tenant_id = $1 AND id = $2;`,
        [tenantId, dto.warehouse_id],
      );

      if (!warehouse) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'WAREHOUSE_NOT_FOUND',
          message: 'Warehouse not found in this tenant',
        });
      }

      // 3. Pessimistic lock on InventoryItem in deterministic order (product_id ASC, warehouse_id ASC)
      const [existingItem] = await qr.query(
        `SELECT * FROM inventory_items
         WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3
         ORDER BY product_id ASC, warehouse_id ASC
         FOR UPDATE;`,
        [tenantId, dto.product_id, dto.warehouse_id],
      );

      let item: InventoryItem;

      if (!existingItem) {
        if (dto.delta < 0) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'INSUFFICIENT_STOCK',
            message: 'Cannot reduce stock below 0 for non-existent inventory item',
          });
        }

        const newItem = qr.manager.create(InventoryItem, {
          tenant_id: tenantId,
          product_id: dto.product_id,
          warehouse_id: dto.warehouse_id,
          on_hand: dto.delta,
          reserved: 0,
          in_transit: 0,
          low_stock_threshold: null,
        });

        item = await qr.manager.save(InventoryItem, newItem);
      } else {
        const currentOnHand = Number(existingItem.on_hand);
        const currentReserved = Number(existingItem.reserved);
        const newOnHand = currentOnHand + dto.delta;

        if (newOnHand < 0 || newOnHand < currentReserved) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'INSUFFICIENT_STOCK',
            message: `Insufficient on-hand stock (${currentOnHand}) to apply delta (${dto.delta}) with reserved (${currentReserved})`,
          });
        }

        const updateResult = await qr.query(
          `UPDATE inventory_items
           SET on_hand = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND tenant_id = $3
           RETURNING *;`,
          [newOnHand, existingItem.id, tenantId],
        );

        const rows =
          Array.isArray(updateResult) && Array.isArray(updateResult[0])
            ? updateResult[0]
            : Array.isArray(updateResult)
              ? updateResult
              : [updateResult];

        item = qr.manager.create(InventoryItem, rows[0]);
      }

      // 4. Create immutable StockMovement
      const movement = qr.manager.create(StockMovement, {
        tenant_id: tenantId,
        product_id: dto.product_id,
        warehouse_id: dto.warehouse_id,
        delta: dto.delta,
        type: StockMovementType.ADJUSTMENT,
        reference_id: null,
      });
      await qr.manager.save(StockMovement, movement);

      // 5. Evaluate LowStockAlert state
      await this.lowStockAlertService.evaluateAlert(tenantId, item, actorUserId, qr.manager);

      // 6. Record AuditLog
      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'INVENTORY_ADJUSTED',
          entityType: 'InventoryItem',
          entityId: item.id,
          metadata: {
            product_id: dto.product_id,
            warehouse_id: dto.warehouse_id,
            delta: dto.delta,
            reason: dto.reason ?? null,
            on_hand: item.on_hand,
            available: item.available,
          },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return item.toJSON ? item.toJSON() : item;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async updateThreshold(
    tenantId: string,
    actorUserId: string,
    itemId: string,
    threshold: number | null | undefined,
  ): Promise<any> {
    if (threshold !== null && threshold !== undefined && threshold < 0) {
      throw new BadRequestException({
        statusCode: 400,
        error_code: 'VALIDATION_ERROR',
        message: 'low_stock_threshold cannot be negative',
      });
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const [existing] = await qr.query(
        `SELECT * FROM inventory_items WHERE id = $1 AND tenant_id = $2 FOR UPDATE;`,
        [itemId, tenantId],
      );

      if (!existing) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'INVENTORY_ITEM_NOT_FOUND',
          message: 'Inventory item not found in this tenant',
        });
      }

      const newThreshold = threshold === undefined ? null : threshold;

      const updateResult = await qr.query(
        `UPDATE inventory_items
         SET low_stock_threshold = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3
         RETURNING *;`,
        [newThreshold, itemId, tenantId],
      );

      const rows =
        Array.isArray(updateResult) && Array.isArray(updateResult[0])
          ? updateResult[0]
          : Array.isArray(updateResult)
            ? updateResult
            : [updateResult];

      const item = qr.manager.create(InventoryItem, rows[0]);

      // Evaluate alert state immediately
      await this.lowStockAlertService.evaluateAlert(tenantId, item, actorUserId, qr.manager);

      // Record AuditLog
      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'LOW_STOCK_THRESHOLD_UPDATED',
          entityType: 'InventoryItem',
          entityId: itemId,
          metadata: {
            previous_threshold: existing.low_stock_threshold,
            new_threshold: newThreshold,
          },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return item.toJSON ? item.toJSON() : item;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getLevels(tenantId: string, query: FindInventoryLevelsQuery) {
    return await this.inventoryRepo.findLevels(tenantId, query);
  }

  async getMovements(tenantId: string, query: FindMovementsQuery) {
    return await this.stockMovementRepo.findMovements(tenantId, query);
  }
}
