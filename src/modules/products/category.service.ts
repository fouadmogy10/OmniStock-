import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Category } from './entities/category.entity';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { AuditLogService } from '../audit/audit.service';

@Injectable()
export class CategoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createCategory(
    tenantId: string,
    actorUserId: string,
    dto: CreateCategoryDto,
  ): Promise<Category> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const [existing] = await qr.query(
        `SELECT id FROM categories WHERE tenant_id = $1 AND lower(name) = lower($2);`,
        [tenantId, dto.name],
      );

      if (existing) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'DUPLICATE_CATEGORY_NAME',
          message: 'Category name already exists in this tenant',
        });
      }

      const category = qr.manager.create(Category, {
        tenant_id: tenantId,
        name: dto.name,
        description: dto.description ?? null,
      });

      const saved = await qr.manager.save(Category, category);

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'CATEGORY_CREATED',
          entityType: 'Category',
          entityId: saved.id,
          metadata: { name: saved.name },
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

  async getCategories(tenantId: string): Promise<Category[]> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const rows = await qr.query(
        `SELECT id, tenant_id, name, description, created_at, updated_at
         FROM categories
         WHERE tenant_id = $1
         ORDER BY name ASC;`,
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

  async updateCategory(
    tenantId: string,
    actorUserId: string,
    id: string,
    dto: UpdateCategoryDto,
  ): Promise<Category> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const [target] = await qr.query(
        `SELECT id, name, description FROM categories WHERE id = $1 AND tenant_id = $2 FOR UPDATE;`,
        [id, tenantId],
      );

      if (!target) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'CATEGORY_NOT_FOUND',
          message: 'Category not found',
        });
      }

      if (dto.name && dto.name.toLowerCase() !== target.name.toLowerCase()) {
        const [dup] = await qr.query(
          `SELECT id FROM categories WHERE tenant_id = $1 AND lower(name) = lower($2) AND id <> $3;`,
          [tenantId, dto.name, id],
        );
        if (dup) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'DUPLICATE_CATEGORY_NAME',
            message: 'Category name already exists in this tenant',
          });
        }
      }

      const newName = dto.name !== undefined ? dto.name : target.name;
      const newDesc = dto.description !== undefined ? dto.description : target.description;

      const updateResult = await qr.query(
        `UPDATE categories
         SET name = $1, description = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND tenant_id = $4
         RETURNING id, tenant_id, name, description, created_at, updated_at;`,
        [newName, newDesc, id, tenantId],
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
          action: 'CATEGORY_UPDATED',
          entityType: 'Category',
          entityId: id,
          metadata: { previous: { name: target.name }, updated: { name: newName } },
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
