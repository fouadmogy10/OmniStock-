import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StockTransfer, StockTransferStatus } from './entities/stock-transfer.entity';
import { StockTransferItem } from './entities/stock-transfer-item.entity';
import { InventoryItem } from './entities/inventory-item.entity';
import { StockMovement, StockMovementType } from './entities/stock-movement.entity';
import { LowStockAlertService } from './low-stock-alert.service';
import { AuditLogService } from '../audit/audit.service';
import { CreateStockTransferDto } from './dto/stock-transfer.dto';

export interface FindTransfersQuery {
  status?: StockTransferStatus;
  source_warehouse_id?: string;
  destination_warehouse_id?: string;
  page?: number;
  limit?: number;
}

function extractFirstRow<T = any>(queryResult: any): T {
  const rows =
    Array.isArray(queryResult) && Array.isArray(queryResult[0])
      ? queryResult[0]
      : Array.isArray(queryResult)
        ? queryResult
        : [queryResult];
  return rows[0];
}

@Injectable()
export class StockTransferService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly lowStockAlertService: LowStockAlertService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createDraft(
    tenantId: string,
    actorUserId: string,
    dto: CreateStockTransferDto,
  ): Promise<StockTransfer> {
    if (dto.source_warehouse_id === dto.destination_warehouse_id) {
      throw new BadRequestException({
        statusCode: 400,
        error_code: 'VALIDATION_ERROR',
        message: 'Source and destination warehouses cannot be the same',
      });
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      // Verify source warehouse
      const [srcWh] = await qr.query(
        `SELECT id, is_active FROM warehouses WHERE tenant_id = $1 AND id = $2;`,
        [tenantId, dto.source_warehouse_id],
      );
      if (!srcWh) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'WAREHOUSE_NOT_FOUND',
          message: 'Source warehouse not found in this tenant',
        });
      }

      // Verify destination warehouse
      const [destWh] = await qr.query(
        `SELECT id, is_active FROM warehouses WHERE tenant_id = $1 AND id = $2;`,
        [tenantId, dto.destination_warehouse_id],
      );
      if (!destWh) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'WAREHOUSE_NOT_FOUND',
          message: 'Destination warehouse not found in this tenant',
        });
      }

      // Verify each product item
      for (const item of dto.items) {
        if (item.quantity <= 0) {
          throw new BadRequestException({
            statusCode: 400,
            error_code: 'VALIDATION_ERROR',
            message: 'Transfer item quantity must be greater than 0',
          });
        }

        const [prod] = await qr.query(
          `SELECT id, is_variant_parent FROM products WHERE tenant_id = $1 AND id = $2;`,
          [tenantId, item.product_id],
        );

        if (!prod) {
          throw new NotFoundException({
            statusCode: 404,
            error_code: 'PRODUCT_NOT_FOUND',
            message: `Product ${item.product_id} not found in this tenant`,
          });
        }

        if (prod.is_variant_parent) {
          throw new BadRequestException({
            statusCode: 400,
            error_code: 'VARIANT_PARENT_NOT_SELLABLE',
            message: `Product ${item.product_id} is a variant parent and cannot be transferred`,
          });
        }
      }

      // Create StockTransfer
      const transfer = qr.manager.create(StockTransfer, {
        tenant_id: tenantId,
        source_warehouse_id: dto.source_warehouse_id,
        destination_warehouse_id: dto.destination_warehouse_id,
        notes: dto.notes ?? null,
        status: StockTransferStatus.DRAFT,
      });

      const savedTransfer = await qr.manager.save(StockTransfer, transfer);

      // Create StockTransferItems
      const itemsToSave = dto.items.map((it) =>
        qr.manager.create(StockTransferItem, {
          tenant_id: tenantId,
          stock_transfer_id: savedTransfer.id,
          product_id: it.product_id,
          quantity: it.quantity,
        }),
      );

      const savedItems = await qr.manager.save(StockTransferItem, itemsToSave);
      savedTransfer.items = savedItems;

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'STOCK_TRANSFER_CREATED',
          entityType: 'StockTransfer',
          entityId: savedTransfer.id,
          metadata: {
            source_warehouse_id: dto.source_warehouse_id,
            destination_warehouse_id: dto.destination_warehouse_id,
            item_count: dto.items.length,
          },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return savedTransfer;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async dispatch(tenantId: string, actorUserId: string, transferId: string): Promise<StockTransfer> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      // 1. Lock StockTransfer header row before validating status
      const [transfer] = await qr.query(
        `SELECT * FROM stock_transfers WHERE id = $1 AND tenant_id = $2 FOR UPDATE;`,
        [transferId, tenantId],
      );

      if (!transfer) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'TRANSFER_NOT_FOUND',
          message: 'Stock transfer not found in this tenant',
        });
      }

      if (transfer.status !== StockTransferStatus.DRAFT) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_TRANSFER_TRANSITION',
          message: `Cannot dispatch transfer in status ${transfer.status}; must be DRAFT`,
        });
      }

      // Load items
      const items: StockTransferItem[] = await qr.query(
        `SELECT * FROM stock_transfer_items WHERE stock_transfer_id = $1 AND tenant_id = $2;`,
        [transferId, tenantId],
      );

      // Sort products deterministically for locking
      const productIds = Array.from(new Set(items.map((i) => i.product_id))).sort();

      // 2. Lock source and destination InventoryItems in (product_id ASC, warehouse_id ASC)
      for (const prodId of productIds) {
        const warehousesToLock = [transfer.source_warehouse_id, transfer.destination_warehouse_id].sort();
        for (const whId of warehousesToLock) {
          await qr.query(
            `SELECT id FROM inventory_items
             WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3
             FOR UPDATE;`,
            [tenantId, prodId, whId],
          );
        }
      }

      // 3. Process each item: source on_hand -= qty, destination in_transit += qty
      for (const it of items) {
        const qty = Number(it.quantity);

        const [sourceItemRow] = await qr.query(
          `SELECT * FROM inventory_items
           WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3;`,
          [tenantId, it.product_id, transfer.source_warehouse_id],
        );

        const sourceOnHand = sourceItemRow ? Number(sourceItemRow.on_hand) : 0;
        const sourceReserved = sourceItemRow ? Number(sourceItemRow.reserved) : 0;
        const sourceAvailable = sourceOnHand - sourceReserved;

        if (sourceAvailable < qty) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'INSUFFICIENT_STOCK',
            message: `Insufficient available stock in source warehouse for product ${it.product_id} (available: ${sourceAvailable}, required: ${qty})`,
          });
        }

        const newSourceOnHand = sourceOnHand - qty;
        const updateSourceRes = await qr.query(
          `UPDATE inventory_items
           SET on_hand = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND tenant_id = $3
           RETURNING *;`,
          [newSourceOnHand, sourceItemRow.id, tenantId],
        );
        const updatedSource = extractFirstRow(updateSourceRes);

        // Source outbound StockMovement
        const srcMovement = qr.manager.create(StockMovement, {
          tenant_id: tenantId,
          product_id: it.product_id,
          warehouse_id: transfer.source_warehouse_id,
          delta: -qty,
          type: StockMovementType.TRANSFER,
          reference_id: transferId,
        });
        await qr.manager.save(StockMovement, srcMovement);

        // Evaluate source low stock alert
        const sourceEntity = qr.manager.create(InventoryItem, updatedSource);
        await this.lowStockAlertService.evaluateAlert(tenantId, sourceEntity, actorUserId, qr.manager);

        // Destination: increment in_transit
        const [destItemRow] = await qr.query(
          `SELECT * FROM inventory_items
           WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3;`,
          [tenantId, it.product_id, transfer.destination_warehouse_id],
        );

        if (!destItemRow) {
          await qr.query(
            `INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, on_hand, reserved, in_transit)
             VALUES ($1, $2, $3, 0, 0, $4);`,
            [tenantId, it.product_id, transfer.destination_warehouse_id, qty],
          );
        } else {
          const newDestInTransit = Number(destItemRow.in_transit) + qty;
          await qr.query(
            `UPDATE inventory_items
             SET in_transit = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND tenant_id = $3;`,
            [newDestInTransit, destItemRow.id, tenantId],
          );
        }
      }

      // 4. Update StockTransfer status to IN_TRANSIT
      const updateTransferRes = await qr.query(
        `UPDATE stock_transfers
         SET status = $1, dispatched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3
         RETURNING *;`,
        [StockTransferStatus.IN_TRANSIT, transferId, tenantId],
      );
      const updatedTransfer = extractFirstRow(updateTransferRes);

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'STOCK_TRANSFER_DISPATCHED',
          entityType: 'StockTransfer',
          entityId: transferId,
          metadata: {
            source_warehouse_id: transfer.source_warehouse_id,
            destination_warehouse_id: transfer.destination_warehouse_id,
          },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      updatedTransfer.items = items;
      return updatedTransfer;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async receive(tenantId: string, actorUserId: string, transferId: string): Promise<StockTransfer> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      // 1. Lock StockTransfer header row before validating status
      const [transfer] = await qr.query(
        `SELECT * FROM stock_transfers WHERE id = $1 AND tenant_id = $2 FOR UPDATE;`,
        [transferId, tenantId],
      );

      if (!transfer) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'TRANSFER_NOT_FOUND',
          message: 'Stock transfer not found in this tenant',
        });
      }

      if (transfer.status !== StockTransferStatus.IN_TRANSIT) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_TRANSFER_TRANSITION',
          message: `Cannot receive transfer in status ${transfer.status}; must be IN_TRANSIT`,
        });
      }

      // Load items
      const items: StockTransferItem[] = await qr.query(
        `SELECT * FROM stock_transfer_items WHERE stock_transfer_id = $1 AND tenant_id = $2;`,
        [transferId, tenantId],
      );

      const productIds = Array.from(new Set(items.map((i) => i.product_id))).sort();

      // 2. Lock destination InventoryItems
      for (const prodId of productIds) {
        await qr.query(
          `SELECT id FROM inventory_items
           WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3
           FOR UPDATE;`,
          [tenantId, prodId, transfer.destination_warehouse_id],
        );
      }

      // 3. Process destination: in_transit -= qty, on_hand += qty
      for (const it of items) {
        const qty = Number(it.quantity);

        const [destItemRow] = await qr.query(
          `SELECT * FROM inventory_items
           WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3;`,
          [tenantId, it.product_id, transfer.destination_warehouse_id],
        );

        const currentInTransit = destItemRow ? Number(destItemRow.in_transit) : 0;
        const currentOnHand = destItemRow ? Number(destItemRow.on_hand) : 0;
        const newInTransit = Math.max(0, currentInTransit - qty);
        const newOnHand = currentOnHand + qty;

        const updateDestRes = await qr.query(
          `UPDATE inventory_items
           SET in_transit = $1, on_hand = $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = $3 AND tenant_id = $4
           RETURNING *;`,
          [newInTransit, newOnHand, destItemRow.id, tenantId],
        );
        const updatedDest = extractFirstRow(updateDestRes);

        // Destination inbound StockMovement
        const destMovement = qr.manager.create(StockMovement, {
          tenant_id: tenantId,
          product_id: it.product_id,
          warehouse_id: transfer.destination_warehouse_id,
          delta: qty,
          type: StockMovementType.TRANSFER,
          reference_id: transferId,
        });
        await qr.manager.save(StockMovement, destMovement);

        // Evaluate destination low stock alert (resolution check)
        const destEntity = qr.manager.create(InventoryItem, updatedDest);
        await this.lowStockAlertService.evaluateAlert(tenantId, destEntity, actorUserId, qr.manager);
      }

      // 4. Update StockTransfer status to RECEIVED
      const updateTransferRes = await qr.query(
        `UPDATE stock_transfers
         SET status = $1, received_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3
         RETURNING *;`,
        [StockTransferStatus.RECEIVED, transferId, tenantId],
      );
      const updatedTransfer = extractFirstRow(updateTransferRes);

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'STOCK_TRANSFER_RECEIVED',
          entityType: 'StockTransfer',
          entityId: transferId,
          metadata: {
            destination_warehouse_id: transfer.destination_warehouse_id,
          },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      updatedTransfer.items = items;
      return updatedTransfer;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async cancel(tenantId: string, actorUserId: string, transferId: string): Promise<StockTransfer> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const [transfer] = await qr.query(
        `SELECT * FROM stock_transfers WHERE id = $1 AND tenant_id = $2 FOR UPDATE;`,
        [transferId, tenantId],
      );

      if (!transfer) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'TRANSFER_NOT_FOUND',
          message: 'Stock transfer not found in this tenant',
        });
      }

      if (transfer.status !== StockTransferStatus.DRAFT) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_TRANSFER_TRANSITION',
          message: `Cannot cancel transfer in status ${transfer.status}; must be DRAFT`,
        });
      }

      const updateTransferRes = await qr.query(
        `UPDATE stock_transfers
         SET status = $1, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3
         RETURNING *;`,
        [StockTransferStatus.CANCELLED, transferId, tenantId],
      );
      const updated = extractFirstRow(updateTransferRes);

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'STOCK_TRANSFER_CANCELLED',
          entityType: 'StockTransfer',
          entityId: transferId,
          metadata: { previous_status: transfer.status },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return updated;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getTransfers(
    tenantId: string,
    query: FindTransfersQuery,
  ): Promise<{ data: StockTransfer[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = (page - 1) * limit;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const qb = qr.manager
        .createQueryBuilder(StockTransfer, 'st')
        .where('st.tenant_id = :tenantId', { tenantId });

      if (query.status) {
        qb.andWhere('st.status = :status', { status: query.status });
      }

      if (query.source_warehouse_id) {
        qb.andWhere('st.source_warehouse_id = :sourceWh', { sourceWh: query.source_warehouse_id });
      }

      if (query.destination_warehouse_id) {
        qb.andWhere('st.destination_warehouse_id = :destWh', { destWh: query.destination_warehouse_id });
      }

      qb.orderBy('st.created_at', 'DESC');
      qb.skip(offset).take(limit);

      const [transfers, total] = await qb.getManyAndCount();

      await qr.commitTransaction();
      return {
        data: transfers,
        total,
        page,
        limit,
      };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getTransferById(tenantId: string, id: string): Promise<StockTransfer> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const transfer = await qr.manager.findOne(StockTransfer, {
        where: {
          tenant_id: tenantId,
          id,
        },
      });

      if (!transfer) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'TRANSFER_NOT_FOUND',
          message: 'Stock transfer not found in this tenant',
        });
      }

      const items = await qr.manager.find(StockTransferItem, {
        where: {
          tenant_id: tenantId,
          stock_transfer_id: id,
        },
        order: { created_at: 'ASC' },
      });

      transfer.items = items;
      await qr.commitTransaction();
      return transfer;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
