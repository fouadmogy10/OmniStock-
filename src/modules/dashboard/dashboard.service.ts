import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Warehouse } from '../warehouses/entities/warehouse.entity';

export interface DashboardSummaryParams {
  from?: string;
  to?: string;
  warehouse_id?: string;
  limit?: number;
}

const ISO_WITH_OFFSET_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

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
export class DashboardService {
  constructor(private readonly dataSource: DataSource) {}

  async getSummary(tenantId: string, params: DashboardSummaryParams): Promise<any> {
    // 1. Strict ISO-8601 validation with explicit timezone offset
    let fromDate: Date;
    let toDate: Date;

    const now = new Date();

    if (params.from !== undefined) {
      if (typeof params.from !== 'string' || !ISO_WITH_OFFSET_REGEX.test(params.from.trim())) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message:
            'from timestamp must be a valid ISO-8601 string with an explicit timezone offset (e.g., 2026-10-01T00:00:00Z)',
        });
      }
      fromDate = new Date(params.from.trim());
      if (isNaN(fromDate.getTime())) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'Invalid from timestamp',
        });
      }
    } else {
      fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    if (params.to !== undefined) {
      if (typeof params.to !== 'string' || !ISO_WITH_OFFSET_REGEX.test(params.to.trim())) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message:
            'to timestamp must be a valid ISO-8601 string with an explicit timezone offset (e.g., 2026-10-30T23:59:59Z)',
        });
      }
      toDate = new Date(params.to.trim());
      if (isNaN(toDate.getTime())) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'Invalid to timestamp',
        });
      }
    } else {
      toDate = now;
    }

    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException({
        statusCode: 400,
        error_code: 'VALIDATION_ERROR',
        message: 'from timestamp cannot be greater than to timestamp',
      });
    }

    // 2. Validate limit (default 10, min 1, max 50)
    let limit = 10;
    if (params.limit !== undefined) {
      const parsedLimit = Number(params.limit);
      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
        throw new BadRequestException({
          statusCode: 400,
          error_code: 'VALIDATION_ERROR',
          message: 'limit must be an integer between 1 and 50',
        });
      }
      limit = Math.floor(parsedLimit);
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      // 3. Optional warehouse scoping
      let warehouse: Warehouse | null = null;
      if (params.warehouse_id) {
        warehouse = await qr.manager.findOne(Warehouse, {
          where: { tenant_id: tenantId, id: params.warehouse_id },
        });
        if (!warehouse) {
          throw new NotFoundException({
            statusCode: 404,
            error_code: 'WAREHOUSE_NOT_FOUND',
            message: `Warehouse ${params.warehouse_id} not found in this tenant`,
          });
        }
      }

      // 4. catalog_and_network counts
      const prodCountsRes = await qr.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE is_variant_parent = false AND is_active = true)::int AS total_products,
          COUNT(*) FILTER (WHERE is_variant_parent = true AND is_active = true)::int AS total_variant_parents
        FROM products
        WHERE tenant_id = $1;
        `,
        [tenantId],
      );
      const prodCounts = extractFirstRow(prodCountsRes) || {
        total_products: 0,
        total_variant_parents: 0,
      };

      const custCountRes = await qr.query(
        `SELECT COUNT(*)::int AS total_customers FROM customers WHERE tenant_id = $1;`,
        [tenantId],
      );
      const totalCustomers = Number(extractFirstRow(custCountRes)?.total_customers || 0);

      const whCountRes = await qr.query(
        `SELECT COUNT(*)::int AS total_warehouses FROM warehouses WHERE tenant_id = $1 AND is_active = true;`,
        [tenantId],
      );
      const totalWarehouses = Number(extractFirstRow(whCountRes)?.total_warehouses || 0);

      // 5. orders_by_status within [from, to]
      const ordersStatusRes: any[] = await qr.query(
        `
        SELECT status, COUNT(*)::int AS count
        FROM orders
        WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3
        GROUP BY status;
        `,
        [tenantId, fromDate.toISOString(), toDate.toISOString()],
      );

      const ordersByStatus: Record<string, number> = {
        DRAFT: 0,
        PENDING: 0,
        ALLOCATED: 0,
        SHIPPED: 0,
        CANCELLED: 0,
      };
      for (const row of ordersStatusRes) {
        if (ordersByStatus[row.status] !== undefined) {
          ordersByStatus[row.status] = Number(row.count);
        }
      }

      // 6. period_order_value (gross Order.total_amount for ALLOCATED and SHIPPED)
      const orderValuesRes = await qr.query(
        `
        SELECT
          COALESCE(SUM(CASE WHEN status = 'ALLOCATED' THEN total_amount ELSE 0 END), 0.00)::numeric(12,2) AS allocated_order_value,
          COALESCE(SUM(CASE WHEN status = 'SHIPPED' THEN total_amount ELSE 0 END), 0.00)::numeric(12,2) AS shipped_order_value,
          COALESCE(SUM(CASE WHEN status IN ('ALLOCATED', 'SHIPPED') THEN total_amount ELSE 0 END), 0.00)::numeric(12,2) AS combined_committed_order_value
        FROM orders
        WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3;
        `,
        [tenantId, fromDate.toISOString(), toDate.toISOString()],
      );
      const orderValRow = extractFirstRow(orderValuesRes) || {};
      const periodOrderValue = {
        allocated_order_value: Number(orderValRow.allocated_order_value || 0),
        shipped_order_value: Number(orderValRow.shipped_order_value || 0),
        combined_committed_order_value: Number(orderValRow.combined_committed_order_value || 0),
      };

      // 7. inventory_quantity_summary (active products in active warehouses)
      let inventorySummary = {
        total_on_hand: 0,
        total_reserved: 0,
        total_available: 0,
        total_in_transit: 0,
      };

      if (!warehouse || warehouse.is_active) {
        const invParams: any[] = [tenantId];
        let invWhClause = '';
        if (warehouse) {
          invParams.push(warehouse.id);
          invWhClause = ` AND ii.warehouse_id = $${invParams.length} `;
        }

        const invRes = await qr.query(
          `
          SELECT
            COALESCE(SUM(ii.on_hand), 0)::int AS total_on_hand,
            COALESCE(SUM(ii.reserved), 0)::int AS total_reserved,
            COALESCE(SUM(ii.on_hand - ii.reserved), 0)::int AS total_available,
            COALESCE(SUM(ii.in_transit), 0)::int AS total_in_transit
          FROM inventory_items ii
          INNER JOIN products p ON p.tenant_id = ii.tenant_id AND p.id = ii.product_id
          INNER JOIN warehouses w ON w.tenant_id = ii.tenant_id AND w.id = ii.warehouse_id
          WHERE ii.tenant_id = $1
            AND p.is_active = true
            AND p.is_variant_parent = false
            AND w.is_active = true
            ${invWhClause};
          `,
          invParams,
        );
        const invRow = extractFirstRow(invRes) || {};
        inventorySummary = {
          total_on_hand: Number(invRow.total_on_hand || 0),
          total_reserved: Number(invRow.total_reserved || 0),
          total_available: Number(invRow.total_available || 0),
          total_in_transit: Number(invRow.total_in_transit || 0),
        };
      }

      // 8. low_stock_alerts_count (OPEN alerts for active products in active warehouses)
      let lowStockAlertsCount = 0;
      if (!warehouse || warehouse.is_active) {
        const alertParams: any[] = [tenantId];
        let alertWhClause = '';
        if (warehouse) {
          alertParams.push(warehouse.id);
          alertWhClause = ` AND lsa.warehouse_id = $${alertParams.length} `;
        }

        const alertRes = await qr.query(
          `
          SELECT COUNT(*)::int AS count
          FROM low_stock_alerts lsa
          INNER JOIN products p ON p.tenant_id = lsa.tenant_id AND p.id = lsa.product_id
          INNER JOIN warehouses w ON w.tenant_id = lsa.tenant_id AND w.id = lsa.warehouse_id
          WHERE lsa.tenant_id = $1
            AND lsa.status = 'OPEN'
            AND p.is_active = true
            AND w.is_active = true
            ${alertWhClause};
          `,
          alertParams,
        );
        lowStockAlertsCount = Number(extractFirstRow(alertRes)?.count || 0);
      }

      // 9. recent_orders (bounded by limit in [from, to])
      const recentOrdersRes: any[] = await qr.query(
        `
        SELECT
          id,
          customer_id,
          customer_name_snapshot,
          status,
          total_amount::numeric(12,2) AS total_amount,
          created_at
        FROM orders
        WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3
        ORDER BY created_at DESC, id DESC
        LIMIT $4;
        `,
        [tenantId, fromDate.toISOString(), toDate.toISOString(), limit],
      );
      const recentOrders = recentOrdersRes.map((r) => ({
        id: r.id,
        customer_id: r.customer_id,
        customer_name_snapshot: r.customer_name_snapshot,
        status: r.status,
        total_amount: Number(r.total_amount),
        created_at: r.created_at,
      }));

      // 10. recent_stock_movements (bounded by limit in [from, to])
      const movParams: any[] = [tenantId, fromDate.toISOString(), toDate.toISOString()];
      let movWhClause = '';
      if (warehouse) {
        movParams.push(warehouse.id);
        movWhClause = ` AND sm.warehouse_id = $${movParams.length} `;
      }
      movParams.push(limit);

      const recentMovementsRes: any[] = await qr.query(
        `
        SELECT
          sm.id,
          sm.product_id,
          sm.warehouse_id,
          sm.delta,
          sm.type,
          sm.reference_id,
          sm.created_at
        FROM stock_movements sm
        WHERE sm.tenant_id = $1
          AND sm.created_at >= $2
          AND sm.created_at <= $3
          ${movWhClause}
        ORDER BY sm.created_at DESC, sm.id DESC
        LIMIT $${movParams.length};
        `,
        movParams,
      );
      const recentStockMovements = recentMovementsRes.map((m) => ({
        id: m.id,
        product_id: m.product_id,
        warehouse_id: m.warehouse_id,
        delta: Number(m.delta),
        type: m.type,
        reference_id: m.reference_id,
        created_at: m.created_at,
      }));

      await qr.commitTransaction();

      return {
        period: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
          timezone: 'UTC',
        },
        warehouse_id: warehouse ? warehouse.id : null,
        catalog_and_network: {
          total_products: Number(prodCounts.total_products || 0),
          total_variant_parents: Number(prodCounts.total_variant_parents || 0),
          total_customers: totalCustomers,
          total_warehouses: totalWarehouses,
        },
        orders_by_status: ordersByStatus,
        period_order_value: periodOrderValue,
        inventory_quantity_summary: inventorySummary,
        low_stock_alerts_count: lowStockAlertsCount,
        recent_orders: recentOrders,
        recent_stock_movements: recentStockMovements,
      };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
