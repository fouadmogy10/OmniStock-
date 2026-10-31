import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Warehouse } from './entities/warehouse.entity';
import { CreateWarehouseDto, UpdateWarehouseDto } from './dto/warehouse.dto';
import { AuditLogService } from '../audit/audit.service';

@Injectable()
export class WarehouseService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createWarehouse(
    tenantId: string,
    actorUserId: string,
    dto: CreateWarehouseDto,
  ): Promise<Warehouse> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const priority = dto.priority !== undefined ? dto.priority : 1;
      if (priority < 1) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'Warehouse priority must be at least 1',
        });
      }

      const [existing] = await qr.query(
        `SELECT id FROM warehouses WHERE tenant_id = $1 AND lower(name) = lower($2);`,
        [tenantId, dto.name],
      );

      if (existing) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'DUPLICATE_WAREHOUSE_NAME',
          message: 'Warehouse name already exists in this tenant',
        });
      }

      const warehouse = qr.manager.create(Warehouse, {
        tenant_id: tenantId,
        name: dto.name,
        location: dto.location ?? null,
        priority,
        is_active: dto.is_active !== undefined ? dto.is_active : true,
      });

      const saved = await qr.manager.save(Warehouse, warehouse);

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'WAREHOUSE_CREATED',
          entityType: 'Warehouse',
          entityId: saved.id,
          metadata: { name: saved.name, priority: saved.priority },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return saved;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getWarehouses(tenantId: string): Promise<Warehouse[]> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const rows = await qr.query(
        `SELECT id, tenant_id, name, location, priority, is_active, created_at, updated_at
         FROM warehouses
         WHERE tenant_id = $1
         ORDER BY priority ASC, created_at ASC, id ASC;`,
        [tenantId],
      );

      await qr.commitTransaction();
      return rows;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async updateWarehouse(
    tenantId: string,
    actorUserId: string,
    id: string,
    dto: UpdateWarehouseDto,
  ): Promise<Warehouse> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const [target] = await qr.query(
        `SELECT * FROM warehouses WHERE id = $1 AND tenant_id = $2 FOR UPDATE;`,
        [id, tenantId],
      );

      if (!target) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'WAREHOUSE_NOT_FOUND',
          message: 'Warehouse not found in this tenant',
        });
      }

      if (dto.priority !== undefined && dto.priority < 1) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'Warehouse priority must be at least 1',
        });
      }

      if (dto.name && dto.name.toLowerCase() !== target.name.toLowerCase()) {
        const [dup] = await qr.query(
          `SELECT id FROM warehouses WHERE tenant_id = $1 AND lower(name) = lower($2) AND id <> $3;`,
          [tenantId, dto.name, id],
        );
        if (dup) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'DUPLICATE_WAREHOUSE_NAME',
            message: 'Warehouse name already exists in this tenant',
          });
        }
      }

      // Active Stock Commitment Guard on Deactivation (A5-3)
      if (dto.is_active === false && target.is_active === true) {
        const commitments = await qr.query(
          `SELECT id, product_id, warehouse_id, reserved, in_transit
           FROM inventory_items
           WHERE tenant_id = $1 AND warehouse_id = $2 AND (reserved > 0 OR in_transit > 0)
           ORDER BY product_id ASC, warehouse_id ASC
           FOR UPDATE;`,
          [tenantId, id],
        );

        if (commitments.length > 0) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'WAREHOUSE_HAS_ACTIVE_STOCK_COMMITMENTS',
            message: 'Warehouse has active stock commitments (reserved or in_transit stock)',
          });
        }
      }

      const newName = dto.name !== undefined ? dto.name : target.name;
      const newLoc = dto.location !== undefined ? dto.location : target.location;
      const newPriority = dto.priority !== undefined ? dto.priority : target.priority;
      const newIsActive = dto.is_active !== undefined ? dto.is_active : target.is_active;

      const updateResult = await qr.query(
        `UPDATE warehouses
         SET name = $1, location = $2, priority = $3, is_active = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND tenant_id = $6
         RETURNING *;`,
        [newName, newLoc, newPriority, newIsActive, id, tenantId],
      );

      const rows =
        Array.isArray(updateResult) && Array.isArray(updateResult[0])
          ? updateResult[0]
          : Array.isArray(updateResult)
            ? updateResult
            : [updateResult];
      const updated = rows[0];

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'WAREHOUSE_UPDATED',
          entityType: 'Warehouse',
          entityId: id,
          metadata: { previous: { name: target.name, is_active: target.is_active }, updated: { name: newName, is_active: newIsActive } },
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
}
