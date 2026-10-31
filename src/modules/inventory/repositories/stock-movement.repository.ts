import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { StockMovement, StockMovementType } from '../entities/stock-movement.entity';

export interface FindMovementsQuery {
  product_id?: string;
  warehouse_id?: string;
  type?: StockMovementType;
  reference_id?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class StockMovementRepository {
  private readonly repo: Repository<StockMovement>;

  constructor(private readonly dataSource: DataSource) {
    this.repo = this.dataSource.getRepository(StockMovement);
  }

  /**
   * Append-only record creation.
   * Can accept an existing transactional EntityManager to participate in parent transactions.
   */
  async createMovement(
    movement: Partial<StockMovement>,
    em?: EntityManager,
  ): Promise<StockMovement> {
    const manager = em || this.repo.manager;
    const entity = manager.create(StockMovement, movement);
    return await manager.save(StockMovement, entity);
  }

  /**
   * Query movements for a tenant with pagination and filters.
   */
  async findMovements(
    tenantId: string,
    query: FindMovementsQuery,
    em?: EntityManager,
  ): Promise<{ data: StockMovement[]; total: number; page: number; limit: number }> {
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
        .createQueryBuilder(StockMovement, 'sm')
        .where('sm.tenant_id = :tenantId', { tenantId });

      if (query.product_id) {
        qb.andWhere('sm.product_id = :productId', { productId: query.product_id });
      }

      if (query.warehouse_id) {
        qb.andWhere('sm.warehouse_id = :warehouseId', { warehouseId: query.warehouse_id });
      }

      if (query.type) {
        qb.andWhere('sm.type = :type', { type: query.type });
      }

      if (query.reference_id) {
        qb.andWhere('sm.reference_id = :referenceId', { referenceId: query.reference_id });
      }

      if (query.from) {
        qb.andWhere('sm.created_at >= :from', { from: query.from });
      }

      if (query.to) {
        qb.andWhere('sm.created_at <= :to', { to: query.to });
      }

      qb.orderBy('sm.created_at', 'DESC').addOrderBy('sm.id', 'DESC');
      qb.skip(offset).take(limit);

      const [data, total] = await qb.getManyAndCount();

      if (qr) {
        await qr.commitTransaction();
      }

      return {
        data,
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
