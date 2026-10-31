import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { InventoryItem } from '../entities/inventory-item.entity';

export interface FindInventoryLevelsQuery {
  sku?: string;
  product_id?: string;
  warehouse_id?: string;
  low_stock_only?: boolean;
  page?: number;
  limit?: number;
}

@Injectable()
export class InventoryRepository {
  private readonly repo: Repository<InventoryItem>;

  constructor(private readonly dataSource: DataSource) {
    this.repo = this.dataSource.getRepository(InventoryItem);
  }

  async findByProductAndWarehouse(
    tenantId: string,
    productId: string,
    warehouseId: string,
    em?: EntityManager,
  ): Promise<InventoryItem | null> {
    const manager = em || this.repo.manager;
    return await manager.findOne(InventoryItem, {
      where: {
        tenant_id: tenantId,
        product_id: productId,
        warehouse_id: warehouseId,
      },
    });
  }

  async findById(tenantId: string, id: string, em?: EntityManager): Promise<InventoryItem | null> {
    const manager = em || this.repo.manager;
    return await manager.findOne(InventoryItem, {
      where: {
        tenant_id: tenantId,
        id,
      },
    });
  }

  async save(item: InventoryItem, em?: EntityManager): Promise<InventoryItem> {
    const manager = em || this.repo.manager;
    return await manager.save(InventoryItem, item);
  }

  async findLevels(
    tenantId: string,
    query: FindInventoryLevelsQuery,
    em?: EntityManager,
  ): Promise<{ data: any[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = (page - 1) * limit;

    const qr = em ? null : this.dataSource.createQueryRunner();
    if (qr) {
      await qr.connect();
      await qr.startTransaction();
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
    }

    try {
      const manager = em || qr!.manager;
      const qb = manager
        .createQueryBuilder(InventoryItem, 'ii')
        .innerJoin('products', 'p', 'p.id = ii.product_id AND p.tenant_id = ii.tenant_id')
        .where('ii.tenant_id = :tenantId', { tenantId });

      if (query.product_id) {
        qb.andWhere('ii.product_id = :productId', { productId: query.product_id });
      }

      if (query.warehouse_id) {
        qb.andWhere('ii.warehouse_id = :warehouseId', { warehouseId: query.warehouse_id });
      }

      if (query.sku) {
        qb.andWhere('lower(p.sku) = lower(:sku)', { sku: query.sku });
      }

      if (query.low_stock_only === true) {
        qb.andWhere('ii.low_stock_threshold IS NOT NULL');
        qb.andWhere('(ii.on_hand - ii.reserved) <= ii.low_stock_threshold');
      }

      qb.orderBy('ii.created_at', 'DESC');
      qb.skip(offset).take(limit);

      const [items, total] = await qb.getManyAndCount();

      if (qr) {
        await qr.commitTransaction();
      }

      return {
        data: items.map((i) => (i.toJSON ? i.toJSON() : {
          id: i.id,
          tenant_id: i.tenant_id,
          product_id: i.product_id,
          warehouse_id: i.warehouse_id,
          on_hand: Number(i.on_hand),
          reserved: Number(i.reserved),
          available: i.available,
          in_transit: Number(i.in_transit),
          low_stock_threshold:
            i.low_stock_threshold !== null && i.low_stock_threshold !== undefined
              ? Number(i.low_stock_threshold)
              : null,
          created_at: i.created_at,
          updated_at: i.updated_at,
        })),
        total,
        page,
        limit,
      };
    } catch (err) {
      if (qr) {
        await qr.rollbackTransaction();
      }
      throw err;
    } finally {
      if (qr) {
        await qr.release();
      }
    }
  }
}
