import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { LowStockAlert, LowStockAlertStatus } from './entities/low-stock-alert.entity';
import { InventoryItem } from './entities/inventory-item.entity';
import { AuditLogService } from '../audit/audit.service';

export interface FindAlertsQuery {
  status?: LowStockAlertStatus;
  warehouse_id?: string;
  product_id?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class LowStockAlertService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Evaluate and sync LowStockAlert state for an InventoryItem.
   * Runs within the caller's transaction via provided EntityManager.
   */
  async evaluateAlert(
    tenantId: string,
    item: InventoryItem,
    actorUserId?: string,
    em?: EntityManager,
  ): Promise<LowStockAlert | null> {
    const manager = em || this.dataSource.manager;
    const available = (item.on_hand ?? 0) - (item.reserved ?? 0);
    const hasThreshold = item.low_stock_threshold !== null && item.low_stock_threshold !== undefined;

    // Check for existing OPEN alert
    const existingOpenAlert = await manager.findOne(LowStockAlert, {
      where: {
        tenant_id: tenantId,
        inventory_item_id: item.id,
        status: LowStockAlertStatus.OPEN,
      },
    });

    if (hasThreshold && available <= item.low_stock_threshold!) {
      // Alert condition active
      if (existingOpenAlert) {
        existingOpenAlert.current_available = available;
        existingOpenAlert.threshold = item.low_stock_threshold!;
        existingOpenAlert.updated_at = new Date();
        return await manager.save(LowStockAlert, existingOpenAlert);
      } else {
        const newAlert = manager.create(LowStockAlert, {
          tenant_id: tenantId,
          inventory_item_id: item.id,
          product_id: item.product_id,
          warehouse_id: item.warehouse_id,
          threshold: item.low_stock_threshold!,
          current_available: available,
          status: LowStockAlertStatus.OPEN,
          triggered_at: new Date(),
        });

        const saved = await manager.save(LowStockAlert, newAlert);

        await this.auditLogService.recordTenantAudit(
          {
            tenantId,
            actorUserId,
            action: 'LOW_STOCK_ALERT_TRIGGERED',
            entityType: 'LowStockAlert',
            entityId: saved.id,
            metadata: {
              inventory_item_id: item.id,
              product_id: item.product_id,
              warehouse_id: item.warehouse_id,
              threshold: item.low_stock_threshold,
              current_available: available,
            },
          },
          manager,
        );

        return saved;
      }
    } else {
      // Healthy or threshold removed: resolve existing OPEN alert if present
      if (existingOpenAlert) {
        existingOpenAlert.status = LowStockAlertStatus.RESOLVED;
        existingOpenAlert.resolved_at = new Date();
        existingOpenAlert.current_available = available;
        existingOpenAlert.updated_at = new Date();
        const resolved = await manager.save(LowStockAlert, existingOpenAlert);

        await this.auditLogService.recordTenantAudit(
          {
            tenantId,
            actorUserId,
            action: 'LOW_STOCK_ALERT_RESOLVED',
            entityType: 'LowStockAlert',
            entityId: resolved.id,
            metadata: {
              inventory_item_id: item.id,
              product_id: item.product_id,
              warehouse_id: item.warehouse_id,
              current_available: available,
            },
          },
          manager,
        );

        return resolved;
      }
    }

    return null;
  }

  /**
   * List low stock alerts with pagination and optional status/warehouse/product filtering.
   */
  async getAlerts(
    tenantId: string,
    query: FindAlertsQuery,
  ): Promise<{ data: LowStockAlert[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = (page - 1) * limit;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const qb = qr.manager
        .createQueryBuilder(LowStockAlert, 'lsa')
        .where('lsa.tenant_id = :tenantId', { tenantId });

      if (query.status) {
        qb.andWhere('lsa.status = :status', { status: query.status });
      }

      if (query.warehouse_id) {
        qb.andWhere('lsa.warehouse_id = :warehouseId', { warehouseId: query.warehouse_id });
      }

      if (query.product_id) {
        qb.andWhere('lsa.product_id = :productId', { productId: query.product_id });
      }

      qb.orderBy('lsa.triggered_at', 'DESC').addOrderBy('lsa.id', 'DESC');
      qb.skip(offset).take(limit);

      const [data, total] = await qb.getManyAndCount();

      await qr.commitTransaction();
      return {
        data,
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

  /**
   * Get single low stock alert by ID.
   */
  async getAlertById(tenantId: string, id: string): Promise<LowStockAlert> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const alert = await qr.manager.findOne(LowStockAlert, {
        where: {
          tenant_id: tenantId,
          id,
        },
      });

      if (!alert) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'ALERT_NOT_FOUND',
          message: 'Low stock alert not found',
        });
      }

      await qr.commitTransaction();
      return alert;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
