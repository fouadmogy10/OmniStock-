import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Order, OrderStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderAllocation } from './entities/order-allocation.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Product } from '../products/entities/product.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { StockMovement, StockMovementType } from '../inventory/entities/stock-movement.entity';
import { AllocationService } from './allocation.service';
import { LowStockAlertService } from '../inventory/low-stock-alert.service';
import { AuditLogService } from '../audit/audit.service';
import { CreateOrderDto, UpdateOrderDto, FindOrdersQuery } from './dto/order.dto';

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
export class OrderService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly allocationService: AllocationService,
    private readonly lowStockAlertService: LowStockAlertService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(
    tenantId: string,
    actorUserId: string,
    dto: CreateOrderDto,
  ): Promise<Order> {
    const autoAllocate = dto.auto_allocate !== false;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      // 1. Verify customer exists in tenant
      const customer = await qr.manager.findOne(Customer, {
        where: { tenant_id: tenantId, id: dto.customer_id },
      });
      if (!customer) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'CUSTOMER_NOT_FOUND',
          message: `Customer ${dto.customer_id} not found in this tenant`,
        });
      }

      // 2. Validate line items and products
      if (!dto.items || dto.items.length === 0) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'Order must contain at least one line item',
        });
      }

      const productIds = dto.items.map((i) => i.product_id);
      const products = await qr.manager.find(Product, {
        where: { tenant_id: tenantId, id: In(productIds) },
      });
      const productMap = new Map<string, Product>();
      for (const p of products) {
        productMap.set(p.id, p);
      }

      let totalAmount = 0;
      const validatedItemsData: {
        product_id: string;
        quantity: number;
        unit_price: number;
        sku: string;
      }[] = [];

      for (const itemDto of dto.items) {
        const prod = productMap.get(itemDto.product_id);
        if (!prod) {
          throw new NotFoundException({
            statusCode: 404,
            error_code: 'PRODUCT_NOT_FOUND',
            message: `Product ${itemDto.product_id} not found in this tenant`,
          });
        }

        if (prod.is_variant_parent) {
          throw new BadRequestException({
            statusCode: 400,
            error_code: 'VALIDATION_ERROR',
            message: `Product ${prod.sku} is a variant parent container and cannot be ordered`,
          });
        }

        const unitPrice =
          itemDto.unit_price !== undefined && itemDto.unit_price !== null
            ? Number(itemDto.unit_price)
            : Number(prod.price);

        if (unitPrice < 0) {
          throw new BadRequestException({
            statusCode: 400,
            error_code: 'VALIDATION_ERROR',
            message: 'Unit price cannot be negative',
          });
        }

        totalAmount += itemDto.quantity * unitPrice;
        validatedItemsData.push({
          product_id: itemDto.product_id,
          quantity: itemDto.quantity,
          unit_price: unitPrice,
          sku: prod.sku,
        });
      }

      // 3. Create Order
      const initialStatus = autoAllocate ? OrderStatus.ALLOCATED : OrderStatus.DRAFT;
      const orderEntity = qr.manager.create(Order, {
        tenant_id: tenantId,
        customer_id: customer.id,
        customer_name_snapshot: customer.name,
        customer_email_snapshot: customer.email ?? null,
        status: initialStatus,
        total_amount: Math.round(totalAmount * 100) / 100,
      });

      const savedOrder = await qr.manager.save(Order, orderEntity);

      // 4. Create OrderItems
      const savedItems: OrderItem[] = [];
      for (const itemData of validatedItemsData) {
        const itemEntity = qr.manager.create(OrderItem, {
          tenant_id: tenantId,
          order_id: savedOrder.id,
          product_id: itemData.product_id,
          quantity: itemData.quantity,
          unit_price: itemData.unit_price,
        });
        const savedItem = await qr.manager.save(OrderItem, itemEntity);
        savedItem.sku = itemData.sku;
        savedItem.allocations = [];
        savedItems.push(savedItem);
      }

      // 5. If autoAllocate is true, execute allocation inside the transaction
      if (autoAllocate) {
        const allocations = await this.allocationService.allocateOrder(
          tenantId,
          actorUserId,
          savedOrder.id,
          savedItems,
          qr,
        );

        // Attach allocations to items
        for (const item of savedItems) {
          item.allocations = allocations.filter((a) => a.order_item_id === item.id);
        }

        await this.auditLogService.recordTenantAudit(
          {
            tenantId,
            actorUserId,
            action: 'ORDER_CREATED',
            entityType: 'Order',
            entityId: savedOrder.id,
            metadata: {
              customer_id: customer.id,
              total_amount: savedOrder.total_amount,
              auto_allocate: true,
            },
          },
          qr.manager,
        );

        await this.auditLogService.recordTenantAudit(
          {
            tenantId,
            actorUserId,
            action: 'ORDER_ALLOCATED',
            entityType: 'Order',
            entityId: savedOrder.id,
            metadata: { allocations_count: allocations.length },
          },
          qr.manager,
        );
      } else {
        await this.auditLogService.recordTenantAudit(
          {
            tenantId,
            actorUserId,
            action: 'ORDER_CREATED',
            entityType: 'Order',
            entityId: savedOrder.id,
            metadata: {
              customer_id: customer.id,
              total_amount: savedOrder.total_amount,
              auto_allocate: false,
            },
          },
          qr.manager,
        );
      }

      savedOrder.items = savedItems;

      await qr.commitTransaction();
      return savedOrder;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async updateDraft(
    tenantId: string,
    actorUserId: string,
    id: string,
    dto: UpdateOrderDto,
  ): Promise<Order> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const rawOrders = await qr.query(
        `SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
        [tenantId, id],
      );
      const rawOrder = extractFirstRow(rawOrders);
      if (!rawOrder) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'ORDER_NOT_FOUND',
          message: `Order ${id} not found in this tenant`,
        });
      }

      if (rawOrder.status !== OrderStatus.DRAFT) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_ORDER_TRANSITION',
          message: `Order in status ${rawOrder.status} cannot be modified. Only DRAFT orders can be updated`,
        });
      }

      if (dto.customer_id) {
        const customer = await qr.manager.findOne(Customer, {
          where: { tenant_id: tenantId, id: dto.customer_id },
        });
        if (!customer) {
          throw new NotFoundException({
            statusCode: 404,
            error_code: 'CUSTOMER_NOT_FOUND',
            message: `Customer ${dto.customer_id} not found in this tenant`,
          });
        }
        await qr.query(
          `UPDATE orders SET customer_id = $1, customer_name_snapshot = $2, customer_email_snapshot = $3, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $4 AND id = $5;`,
          [customer.id, customer.name, customer.email ?? null, tenantId, id],
        );
      }

      if (dto.items) {
        if (dto.items.length === 0) {
          throw new BadRequestException({
            statusCode: 400,
            error_code: 'VALIDATION_ERROR',
            message: 'Order must contain at least one line item',
          });
        }

        const productIds = dto.items.map((i) => i.product_id);
        const products = await qr.manager.find(Product, {
          where: { tenant_id: tenantId, id: In(productIds) },
        });
        const productMap = new Map<string, Product>();
        for (const p of products) {
          productMap.set(p.id, p);
        }

        let totalAmount = 0;
        const validatedItemsData: {
          product_id: string;
          quantity: number;
          unit_price: number;
        }[] = [];

        for (const itemDto of dto.items) {
          const prod = productMap.get(itemDto.product_id);
          if (!prod) {
            throw new NotFoundException({
              statusCode: 404,
              error_code: 'PRODUCT_NOT_FOUND',
              message: `Product ${itemDto.product_id} not found`,
            });
          }

          if (prod.is_variant_parent) {
            throw new BadRequestException({
              statusCode: 400,
              error_code: 'VALIDATION_ERROR',
              message: `Product ${prod.sku} is a variant parent container and cannot be ordered`,
            });
          }

          const unitPrice =
            itemDto.unit_price !== undefined && itemDto.unit_price !== null
              ? Number(itemDto.unit_price)
              : Number(prod.price);

          totalAmount += itemDto.quantity * unitPrice;
          validatedItemsData.push({
            product_id: itemDto.product_id,
            quantity: itemDto.quantity,
            unit_price: unitPrice,
          });
        }

        // Delete existing items
        await qr.query(`DELETE FROM order_items WHERE tenant_id = $1 AND order_id = $2;`, [
          tenantId,
          id,
        ]);

        // Insert new items
        for (const itemData of validatedItemsData) {
          const itemEntity = qr.manager.create(OrderItem, {
            tenant_id: tenantId,
            order_id: id,
            product_id: itemData.product_id,
            quantity: itemData.quantity,
            unit_price: itemData.unit_price,
          });
          await qr.manager.save(OrderItem, itemEntity);
        }

        // Update total_amount
        await qr.query(
          `UPDATE orders SET total_amount = $1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $2 AND id = $3;`,
          [Math.round(totalAmount * 100) / 100, tenantId, id],
        );
      }

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'ORDER_UPDATED',
          entityType: 'Order',
          entityId: id,
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return await this.getOrderById(tenantId, id);
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async submit(tenantId: string, actorUserId: string, id: string): Promise<Order> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const rawOrders = await qr.query(
        `SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
        [tenantId, id],
      );
      const rawOrder = extractFirstRow(rawOrders);
      if (!rawOrder) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'ORDER_NOT_FOUND',
          message: `Order ${id} not found in this tenant`,
        });
      }

      if (rawOrder.status !== OrderStatus.DRAFT) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_ORDER_TRANSITION',
          message: `Cannot submit order in status ${rawOrder.status}. Must be DRAFT`,
        });
      }

      // Check items exist
      const itemsCountRes = await qr.query(
        `SELECT COUNT(*)::int AS count FROM order_items WHERE tenant_id = $1 AND order_id = $2;`,
        [tenantId, id],
      );
      const itemsCount = Number(extractFirstRow(itemsCountRes)?.count || 0);
      if (itemsCount === 0) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'Order must contain at least one line item before submission',
        });
      }

      await qr.query(
        `UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $2 AND id = $3;`,
        [OrderStatus.PENDING, tenantId, id],
      );

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'ORDER_SUBMITTED',
          entityType: 'Order',
          entityId: id,
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return await this.getOrderById(tenantId, id);
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async allocate(tenantId: string, actorUserId: string, id: string): Promise<Order> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const rawOrders = await qr.query(
        `SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
        [tenantId, id],
      );
      const rawOrder = extractFirstRow(rawOrders);
      if (!rawOrder) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'ORDER_NOT_FOUND',
          message: `Order ${id} not found in this tenant`,
        });
      }

      if (
        rawOrder.status !== OrderStatus.DRAFT &&
        rawOrder.status !== OrderStatus.PENDING
      ) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_ORDER_TRANSITION',
          message: `Cannot allocate order in status ${rawOrder.status}. Must be DRAFT or PENDING`,
        });
      }

      const items = await qr.manager.find(OrderItem, {
        where: { tenant_id: tenantId, order_id: id },
      });

      if (items.length === 0) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'Order has no items to allocate',
        });
      }

      const allocations = await this.allocationService.allocateOrder(
        tenantId,
        actorUserId,
        id,
        items,
        qr,
      );

      await qr.query(
        `UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $2 AND id = $3;`,
        [OrderStatus.ALLOCATED, tenantId, id],
      );

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'ORDER_ALLOCATED',
          entityType: 'Order',
          entityId: id,
          metadata: { allocations_count: allocations.length },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return await this.getOrderById(tenantId, id);
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async ship(tenantId: string, actorUserId: string, id: string): Promise<Order> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const rawOrders = await qr.query(
        `SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
        [tenantId, id],
      );
      const rawOrder = extractFirstRow(rawOrders);
      if (!rawOrder) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'ORDER_NOT_FOUND',
          message: `Order ${id} not found in this tenant`,
        });
      }

      if (rawOrder.status !== OrderStatus.ALLOCATED) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_ORDER_TRANSITION',
          message: `Cannot ship order in status ${rawOrder.status}. Must be ALLOCATED`,
        });
      }

      const allocations = await qr.manager.find(OrderAllocation, {
        where: { tenant_id: tenantId, order_id: id },
      });

      if (allocations.length === 0) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_ORDER_TRANSITION',
          message: `Allocated order ${id} has no allocation records to ship`,
        });
      }

      // Collect product and warehouse pairs and lock inventory items in (product_id ASC, warehouse_id ASC)
      const sortedKeys = Array.from(
        new Set(allocations.map((a) => `${a.product_id}:::${a.warehouse_id}`)),
      ).sort();

      for (const key of sortedKeys) {
        const [prodId, whId] = key.split(':::');
        await qr.query(
          `
          SELECT * FROM inventory_items
          WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3
          FOR UPDATE;
          `,
          [tenantId, prodId, whId],
        );
      }

      // Decrement on_hand and reserved, and insert SALE StockMovement
      for (const alloc of allocations) {
        await qr.query(
          `
          UPDATE inventory_items
          SET on_hand = on_hand - $1, reserved = reserved - $1, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $2 AND product_id = $3 AND warehouse_id = $4;
          `,
          [alloc.allocated_quantity, tenantId, alloc.product_id, alloc.warehouse_id],
        );

        // Immutable StockMovement
        await qr.query(
          `
          INSERT INTO stock_movements (id, tenant_id, product_id, warehouse_id, delta, type, reference_id, created_at)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP);
          `,
          [
            tenantId,
            alloc.product_id,
            alloc.warehouse_id,
            -alloc.allocated_quantity,
            StockMovementType.SALE,
            id,
          ],
        );
      }

      await qr.query(
        `UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $2 AND id = $3;`,
        [OrderStatus.SHIPPED, tenantId, id],
      );

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'ORDER_SHIPPED',
          entityType: 'Order',
          entityId: id,
          metadata: { allocations_shipped: allocations.length },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return await this.getOrderById(tenantId, id);
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async cancel(tenantId: string, actorUserId: string, id: string): Promise<Order> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const rawOrders = await qr.query(
        `SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE;`,
        [tenantId, id],
      );
      const rawOrder = extractFirstRow(rawOrders);
      if (!rawOrder) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'ORDER_NOT_FOUND',
          message: `Order ${id} not found in this tenant`,
        });
      }

      if (
        rawOrder.status === OrderStatus.SHIPPED ||
        rawOrder.status === OrderStatus.CANCELLED
      ) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INVALID_ORDER_TRANSITION',
          message: `Cannot cancel order in status ${rawOrder.status}. Orders in SHIPPED or CANCELLED status cannot be cancelled`,
        });
      }

      if (rawOrder.status === OrderStatus.ALLOCATED) {
        const allocations = await qr.manager.find(OrderAllocation, {
          where: { tenant_id: tenantId, order_id: id },
        });

        // Sort keys to lock in global deterministic (product_id ASC, warehouse_id ASC) order
        const sortedKeys = Array.from(
          new Set(allocations.map((a) => `${a.product_id}:::${a.warehouse_id}`)),
        ).sort();

        for (const key of sortedKeys) {
          const [prodId, whId] = key.split(':::');
          await qr.query(
            `
            SELECT * FROM inventory_items
            WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3
            FOR UPDATE;
            `,
            [tenantId, prodId, whId],
          );
        }

        // Release reserved stock for each allocation and evaluate LowStockAlert
        for (const alloc of allocations) {
          await qr.query(
            `
            UPDATE inventory_items
            SET reserved = reserved - $1, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = $2 AND product_id = $3 AND warehouse_id = $4;
            `,
            [alloc.allocated_quantity, tenantId, alloc.product_id, alloc.warehouse_id],
          );

          const updatedItem = await qr.manager.findOne(InventoryItem, {
            where: {
              tenant_id: tenantId,
              product_id: alloc.product_id,
              warehouse_id: alloc.warehouse_id,
            },
          });

          if (updatedItem) {
            await this.lowStockAlertService.evaluateAlert(
              tenantId,
              updatedItem,
              actorUserId,
              qr.manager,
            );
          }
        }
      }

      await qr.query(
        `UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $2 AND id = $3;`,
        [OrderStatus.CANCELLED, tenantId, id],
      );

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'ORDER_CANCELLED',
          entityType: 'Order',
          entityId: id,
          metadata: { previous_status: rawOrder.status },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return await this.getOrderById(tenantId, id);
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getOrderById(tenantId: string, id: string): Promise<Order> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const order = await qr.manager.findOne(Order, {
        where: { tenant_id: tenantId, id },
      });

      if (!order) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'ORDER_NOT_FOUND',
          message: `Order ${id} not found in this tenant`,
        });
      }

      // Load items
      const items = await qr.manager.find(OrderItem, {
        where: { tenant_id: tenantId, order_id: id },
        order: { created_at: 'ASC' },
      });

      // Load allocations
      const allocations = await qr.manager.find(OrderAllocation, {
        where: { tenant_id: tenantId, order_id: id },
        order: { created_at: 'ASC' },
      });

      // Attach SKUs
      const productIds = items.map((i) => i.product_id);
      if (productIds.length > 0) {
        const products = await qr.manager.find(Product, {
          where: { tenant_id: tenantId, id: In(productIds) },
        });
        const skuMap = new Map<string, string>();
        for (const p of products) {
          skuMap.set(p.id, p.sku);
        }
        for (const item of items) {
          item.sku = skuMap.get(item.product_id) || '';
          item.allocations = allocations.filter((a) => a.order_item_id === item.id);
        }
      } else {
        for (const item of items) {
          item.allocations = [];
        }
      }

      order.items = items;

      await qr.commitTransaction();
      return order;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getOrders(
    tenantId: string,
    query: FindOrdersQuery,
  ): Promise<{ data: Order[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = (page - 1) * limit;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const qb = qr.manager
        .createQueryBuilder(Order, 'o')
        .where('o.tenant_id = :tenantId', { tenantId });

      if (query.status) {
        qb.andWhere('o.status = :status', { status: query.status });
      }

      if (query.customer_id) {
        qb.andWhere('o.customer_id = :customerId', { customerId: query.customer_id });
      }

      if (query.from) {
        qb.andWhere('o.created_at >= :from', { from: new Date(query.from) });
      }

      if (query.to) {
        qb.andWhere('o.created_at <= :to', { to: new Date(query.to) });
      }

      qb.orderBy('o.created_at', 'DESC').addOrderBy('o.id', 'DESC');
      qb.skip(offset).take(limit);

      const [orders, total] = await qb.getManyAndCount();

      // For each order, populate items and allocations
      for (const order of orders) {
        const items = await qr.manager.find(OrderItem, {
          where: { tenant_id: tenantId, order_id: order.id },
          order: { created_at: 'ASC' },
        });
        const allocations = await qr.manager.find(OrderAllocation, {
          where: { tenant_id: tenantId, order_id: order.id },
          order: { created_at: 'ASC' },
        });

        const productIds = items.map((i) => i.product_id);
        if (productIds.length > 0) {
          const products = await qr.manager.find(Product, {
            where: { tenant_id: tenantId, id: In(productIds) },
          });
          const skuMap = new Map<string, string>();
          for (const p of products) {
            skuMap.set(p.id, p.sku);
          }
          for (const item of items) {
            item.sku = skuMap.get(item.product_id) || '';
            item.allocations = allocations.filter((a) => a.order_item_id === item.id);
          }
        }
        order.items = items;
      }

      await qr.commitTransaction();
      return { data: orders, total, page, limit };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}

