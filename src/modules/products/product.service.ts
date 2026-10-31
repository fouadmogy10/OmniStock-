import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Product } from './entities/product.entity';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { AuditLogService } from '../audit/audit.service';

export interface FindProductsQuery {
  sku?: string;
  barcode?: string;
  category_id?: string;
  parent_product_id?: string;
  is_variant_parent?: boolean;
  is_active?: boolean;
  page?: number;
  limit?: number;
}

@Injectable()
export class ProductService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createProduct(
    tenantId: string,
    actorUserId: string,
    dto: CreateProductDto,
  ): Promise<Product> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      if (dto.price < 0) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'Product price cannot be negative',
        });
      }

      // Check tenant-scoped SKU uniqueness
      const [existingSku] = await qr.query(
        `SELECT id FROM products WHERE tenant_id = $1 AND sku = $2;`,
        [tenantId, dto.sku],
      );
      if (existingSku) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'DUPLICATE_PRODUCT_SKU',
          message: 'Product SKU already exists in this tenant',
        });
      }

      // Check tenant-scoped barcode uniqueness if provided
      if (dto.barcode) {
        const [existingBarcode] = await qr.query(
          `SELECT id FROM products WHERE tenant_id = $1 AND barcode = $2;`,
          [tenantId, dto.barcode],
        );
        if (existingBarcode) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'DUPLICATE_PRODUCT_BARCODE',
            message: 'Product barcode already exists in this tenant',
          });
        }
      }

      // Check category if provided
      if (dto.category_id) {
        const [category] = await qr.query(
          `SELECT id FROM categories WHERE tenant_id = $1 AND id = $2;`,
          [tenantId, dto.category_id],
        );
        if (!category) {
          throw new NotFoundException({
            statusCode: 404,
            error_code: 'CATEGORY_NOT_FOUND',
            message: 'Category not found in this tenant',
          });
        }
      }

      const isVariantParent = dto.is_variant_parent === true;

      // Check parent product relationship
      if (dto.parent_product_id) {
        if (isVariantParent) {
          throw new BadRequestException({
            statusCode: 400,
            error_code: 'VALIDATION_ERROR',
            message: 'Variant parent container cannot have a parent_product_id',
          });
        }

        const [parentProduct] = await qr.query(
          `SELECT id, is_variant_parent FROM products WHERE tenant_id = $1 AND id = $2;`,
          [tenantId, dto.parent_product_id],
        );

        if (!parentProduct || !parentProduct.is_variant_parent) {
          throw new BadRequestException({
            statusCode: 400,
            error_code: 'VALIDATION_ERROR',
            message: 'parent_product_id must reference a product with is_variant_parent = true',
          });
        }
      }

      const product = qr.manager.create(Product, {
        tenant_id: tenantId,
        sku: dto.sku,
        barcode: dto.barcode ?? null,
        name: dto.name,
        description: dto.description ?? null,
        category_id: dto.category_id ?? null,
        parent_product_id: dto.parent_product_id ?? null,
        is_variant_parent: isVariantParent,
        variant_attributes: dto.variant_attributes ?? null,
        price: dto.price,
        is_active: true,
      });

      const saved = await qr.manager.save(Product, product);

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'PRODUCT_CREATED',
          entityType: 'Product',
          entityId: saved.id,
          metadata: { sku: saved.sku, name: saved.name, is_variant_parent: saved.is_variant_parent },
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

  async getProducts(
    tenantId: string,
    query: FindProductsQuery,
  ): Promise<{ data: Product[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = (page - 1) * limit;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const qb = qr.manager
        .createQueryBuilder(Product, 'p')
        .where('p.tenant_id = :tenantId', { tenantId });

      if (query.sku) {
        qb.andWhere('lower(p.sku) = lower(:sku)', { sku: query.sku });
      }

      if (query.barcode) {
        qb.andWhere('p.barcode = :barcode', { barcode: query.barcode });
      }

      if (query.category_id) {
        qb.andWhere('p.category_id = :categoryId', { categoryId: query.category_id });
      }

      if (query.parent_product_id) {
        qb.andWhere('p.parent_product_id = :parentProductId', {
          parentProductId: query.parent_product_id,
        });
      }

      if (query.is_variant_parent !== undefined) {
        qb.andWhere('p.is_variant_parent = :isVariantParent', {
          isVariantParent: query.is_variant_parent,
        });
      }

      if (query.is_active !== undefined) {
        qb.andWhere('p.is_active = :isActive', { isActive: query.is_active });
      }

      qb.orderBy('p.created_at', 'DESC');
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

  async getProductById(tenantId: string, id: string): Promise<Product> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const product = await qr.manager.findOne(Product, {
        where: {
          tenant_id: tenantId,
          id,
        },
      });

      if (!product) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'PRODUCT_NOT_FOUND',
          message: 'Product not found in this tenant',
        });
      }

      if (product.is_variant_parent) {
        const variants = await qr.manager.find(Product, {
          where: {
            tenant_id: tenantId,
            parent_product_id: id,
          },
          order: { created_at: 'ASC' },
        });
        product.variants = variants;
      }

      await qr.commitTransaction();
      return product;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async updateProduct(
    tenantId: string,
    actorUserId: string,
    id: string,
    dto: UpdateProductDto,
  ): Promise<Product> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const [target] = await qr.query(
        `SELECT * FROM products WHERE id = $1 AND tenant_id = $2 FOR UPDATE;`,
        [id, tenantId],
      );

      if (!target) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'PRODUCT_NOT_FOUND',
          message: 'Product not found in this tenant',
        });
      }

      if (dto.price !== undefined && dto.price < 0) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'Product price cannot be negative',
        });
      }

      // Barcode uniqueness check if changed
      if (dto.barcode !== undefined && dto.barcode !== null && dto.barcode !== target.barcode) {
        const [existing] = await qr.query(
          `SELECT id FROM products WHERE tenant_id = $1 AND barcode = $2 AND id <> $3;`,
          [tenantId, dto.barcode, id],
        );
        if (existing) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'DUPLICATE_PRODUCT_BARCODE',
            message: 'Product barcode already exists in this tenant',
          });
        }
      }

      // Category validation
      if (dto.category_id !== undefined && dto.category_id !== null && dto.category_id !== target.category_id) {
        const [category] = await qr.query(
          `SELECT id FROM categories WHERE tenant_id = $1 AND id = $2;`,
          [tenantId, dto.category_id],
        );
        if (!category) {
          throw new NotFoundException({
            statusCode: 404,
            error_code: 'CATEGORY_NOT_FOUND',
            message: 'Category not found in this tenant',
          });
        }
      }

      // Structural hierarchy checks
      const nextIsVariantParent =
        dto.is_variant_parent !== undefined ? dto.is_variant_parent : target.is_variant_parent;
      const nextParentProductId =
        dto.parent_product_id !== undefined ? dto.parent_product_id : target.parent_product_id;

      if (nextIsVariantParent && nextParentProductId) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'Variant hierarchy cannot have multi-level nesting',
        });
      }

      // If converting to variant parent, ensure no existing inventory/orders exist
      if (nextIsVariantParent && !target.is_variant_parent) {
        const [existingStock] = await qr.query(
          `SELECT id FROM inventory_items WHERE tenant_id = $1 AND product_id = $2 LIMIT 1;`,
          [tenantId, id],
        );
        if (existingStock) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'CANNOT_CONVERT_PRODUCT_WITH_STOCK',
            message: 'Cannot convert product with existing inventory items to variant parent',
          });
        }
      }

      const newName = dto.name !== undefined ? dto.name : target.name;
      const newDesc = dto.description !== undefined ? dto.description : target.description;
      const newBarcode = dto.barcode !== undefined ? dto.barcode : target.barcode;
      const newCategory = dto.category_id !== undefined ? dto.category_id : target.category_id;
      const newAttrs =
        dto.variant_attributes !== undefined ? dto.variant_attributes : target.variant_attributes;
      const newPrice = dto.price !== undefined ? dto.price : target.price;
      const newIsActive = dto.is_active !== undefined ? dto.is_active : target.is_active;

      const updateResult = await qr.query(
        `UPDATE products
         SET name = $1, description = $2, barcode = $3, category_id = $4,
             variant_attributes = $5, price = $6, is_active = $7,
             is_variant_parent = $8, parent_product_id = $9, updated_at = CURRENT_TIMESTAMP
         WHERE id = $10 AND tenant_id = $11
         RETURNING *;`,
        [
          newName,
          newDesc,
          newBarcode,
          newCategory,
          newAttrs ? JSON.stringify(newAttrs) : null,
          newPrice,
          newIsActive,
          nextIsVariantParent,
          nextParentProductId,
          id,
          tenantId,
        ],
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
          action: 'PRODUCT_UPDATED',
          entityType: 'Product',
          entityId: id,
          metadata: { sku: target.sku, updated_fields: Object.keys(dto) },
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
