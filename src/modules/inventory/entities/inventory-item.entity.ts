import { Entity, Column } from 'typeorm';
import { BaseTenantEntity } from '../../../common/entities/base.entity';

@Entity('inventory_items')
export class InventoryItem extends BaseTenantEntity {
  @Column({ type: 'uuid' })
  product_id!: string;

  @Column({ type: 'uuid' })
  warehouse_id!: string;

  @Column({ type: 'int', default: 0 })
  on_hand!: number;

  @Column({ type: 'int', default: 0 })
  reserved!: number;

  @Column({ type: 'int', default: 0 })
  in_transit!: number;

  @Column({ type: 'int', nullable: true })
  low_stock_threshold?: number | null;

  get available(): number {
    return (this.on_hand ?? 0) - (this.reserved ?? 0);
  }

  toJSON() {
    return {
      id: this.id,
      tenant_id: this.tenant_id,
      product_id: this.product_id,
      warehouse_id: this.warehouse_id,
      on_hand: Number(this.on_hand),
      reserved: Number(this.reserved),
      available: this.available,
      in_transit: Number(this.in_transit),
      low_stock_threshold:
        this.low_stock_threshold !== undefined && this.low_stock_threshold !== null
          ? Number(this.low_stock_threshold)
          : null,
      created_at: this.created_at,
      updated_at: this.updated_at,
    };
  }
}
