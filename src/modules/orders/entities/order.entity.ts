import { Entity, Column } from 'typeorm';
import { BaseTenantEntity } from '../../../common/entities/base.entity';
import { OrderItem } from './order-item.entity';

export enum OrderStatus {
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  ALLOCATED = 'ALLOCATED',
  SHIPPED = 'SHIPPED',
  CANCELLED = 'CANCELLED',
}

@Entity('orders')
export class Order extends BaseTenantEntity {
  @Column({ type: 'uuid' })
  customer_id!: string;

  @Column({ type: 'varchar', length: 255 })
  customer_name_snapshot!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  customer_email_snapshot?: string | null;

  @Column({
    type: 'varchar',
    length: 50,
    default: OrderStatus.DRAFT,
  })
  status!: OrderStatus;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0.0,
    transformer: {
      to: (v: number) => v,
      from: (v: string | number) => Number(v),
    },
  })
  total_amount!: number;

  // Populated in queries with items
  items?: OrderItem[];
}
