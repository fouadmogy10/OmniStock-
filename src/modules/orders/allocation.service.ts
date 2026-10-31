import { Injectable, ConflictException } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { OrderItem } from './entities/order-item.entity';
import { OrderAllocation } from './entities/order-allocation.entity';
import { LowStockAlertService } from '../inventory/low-stock-alert.service';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';

interface CandidateInventory {
  inventory_item_id: string;
  product_id: string;
  warehouse_id: string;
  on_hand: number;
  reserved: number;
  available: number;
  low_stock_threshold: number | null;
  warehouse_priority: number;
  warehouse_created_at: number;
  allocatedSoFar: number;
}

@Injectable()
export class AllocationService {
  constructor(private readonly lowStockAlertService: LowStockAlertService) {}

  /**
   * Deterministically allocates order items across priority-ordered warehouses.
   *
   * Invariants enforced:
   * 1. Locks candidate InventoryItem rows in global deterministic (product_id ASC, warehouse_id ASC) order.
   * 2. Evaluates allocation preference in memory using (Warehouse.priority ASC, Warehouse.created_at ASC, Warehouse.id ASC).
   * 3. Enforces All-or-Nothing: if any line item cannot be 100% fulfilled across active warehouses,
   *    throws 409 Conflict (INSUFFICIENT_STOCK) and persists zero partial reservations.
   * 4. Updates inventory_items.reserved for affected items.
   * 5. Evaluates LowStockAlertService on affected items.
   * 6. Inserts OrderAllocation rows.
   */
  async allocateOrder(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    items: OrderItem[],
    qr: QueryRunner,
  ): Promise<OrderAllocation[]> {
    if (!items || items.length === 0) {
      return [];
    }

    // 1. Collect and sort unique product IDs for deterministic lock order
    const uniqueProductIds = Array.from(new Set(items.map((i) => i.product_id))).sort();

    // 2. Lock candidate inventory items in global deterministic (product_id ASC, warehouse_id ASC) order
    const rawCandidates: any[] = await qr.query(
      `
      SELECT
        ii.id AS inventory_item_id,
        ii.product_id,
        ii.warehouse_id,
        ii.on_hand,
        ii.reserved,
        ii.low_stock_threshold,
        w.priority AS warehouse_priority,
        w.created_at AS warehouse_created_at
      FROM inventory_items ii
      INNER JOIN warehouses w
        ON w.tenant_id = ii.tenant_id AND w.id = ii.warehouse_id
      WHERE ii.tenant_id = $1
        AND ii.product_id = ANY($2)
        AND w.is_active = true
      ORDER BY ii.product_id ASC, ii.warehouse_id ASC
      FOR UPDATE OF ii;
      `,
      [tenantId, uniqueProductIds],
    );

    // 3. Map into candidate structures
    const candidateMap = new Map<string, CandidateInventory[]>();
    for (const raw of rawCandidates) {
      const onHand = Number(raw.on_hand);
      const reserved = Number(raw.reserved);
      const available = onHand - reserved;
      const threshold =
        raw.low_stock_threshold !== null && raw.low_stock_threshold !== undefined
          ? Number(raw.low_stock_threshold)
          : null;

      const cand: CandidateInventory = {
        inventory_item_id: raw.inventory_item_id,
        product_id: raw.product_id,
        warehouse_id: raw.warehouse_id,
        on_hand: onHand,
        reserved: reserved,
        available: Math.max(0, available),
        low_stock_threshold: threshold,
        warehouse_priority: Number(raw.warehouse_priority),
        warehouse_created_at: new Date(raw.warehouse_created_at).getTime(),
        allocatedSoFar: 0,
      };

      if (!candidateMap.has(raw.product_id)) {
        candidateMap.set(raw.product_id, []);
      }
      candidateMap.get(raw.product_id)!.push(cand);
    }

    // Sort candidate list for each product according to warehouse allocation preference:
    // (priority ASC, created_at ASC, id ASC)
    for (const [_, candidates] of candidateMap.entries()) {
      candidates.sort((a, b) => {
        if (a.warehouse_priority !== b.warehouse_priority) {
          return a.warehouse_priority - b.warehouse_priority;
        }
        if (a.warehouse_created_at !== b.warehouse_created_at) {
          return a.warehouse_created_at - b.warehouse_created_at;
        }
        return a.warehouse_id.localeCompare(b.warehouse_id);
      });
    }

    // 4. Evaluate allocation for each line item
    const plannedAllocations: {
      order_id: string;
      order_item_id: string;
      product_id: string;
      warehouse_id: string;
      allocated_quantity: number;
      candidate: CandidateInventory;
    }[] = [];

    for (const item of items) {
      let remainingNeeded = item.quantity;
      const candidates = candidateMap.get(item.product_id) || [];

      for (const candidate of candidates) {
        if (candidate.available <= 0) {
          continue;
        }

        const allocatable = Math.min(candidate.available, remainingNeeded);
        if (allocatable > 0) {
          candidate.available -= allocatable;
          candidate.allocatedSoFar += allocatable;
          remainingNeeded -= allocatable;

          plannedAllocations.push({
            order_id: orderId,
            order_item_id: item.id,
            product_id: item.product_id,
            warehouse_id: candidate.warehouse_id,
            allocated_quantity: allocatable,
            candidate,
          });

          if (remainingNeeded === 0) {
            break;
          }
        }
      }

      // All-or-nothing check
      if (remainingNeeded > 0) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'INSUFFICIENT_STOCK',
          message: `Insufficient stock to allocate product ${item.product_id}. Required: ${item.quantity}, unfulfillable: ${remainingNeeded}`,
        });
      }
    }

    // 5. Persist OrderAllocations
    const createdAllocations: OrderAllocation[] = [];
    for (const plan of plannedAllocations) {
      const alloc = qr.manager.create(OrderAllocation, {
        tenant_id: tenantId,
        order_id: plan.order_id,
        order_item_id: plan.order_item_id,
        product_id: plan.product_id,
        warehouse_id: plan.warehouse_id,
        allocated_quantity: plan.allocated_quantity,
      });
      const saved = await qr.manager.save(OrderAllocation, alloc);
      createdAllocations.push(saved);
    }

    // 6. Update inventory_items reserved counts and evaluate LowStockAlert
    // Group by inventory_item_id
    const affectedCandidates = new Map<string, CandidateInventory>();
    for (const plan of plannedAllocations) {
      affectedCandidates.set(plan.candidate.inventory_item_id, plan.candidate);
    }

    for (const candidate of affectedCandidates.values()) {
      if (candidate.allocatedSoFar > 0) {
        await qr.query(
          `
          UPDATE inventory_items
          SET reserved = reserved + $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND tenant_id = $3;
          `,
          [candidate.allocatedSoFar, candidate.inventory_item_id, tenantId],
        );

        // Fetch refreshed inventory item to evaluate low stock alert
        const updatedItem = await qr.manager.findOne(InventoryItem, {
          where: { tenant_id: tenantId, id: candidate.inventory_item_id },
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

    return createdAllocations;
  }
}

