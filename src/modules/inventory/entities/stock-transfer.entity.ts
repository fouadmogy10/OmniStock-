import { Entity, Column } from 'typeorm';
import { BaseTenantEntity } from '../../../common/entities/base.entity';
import { StockTransferItem } from './stock-transfer-item.entity';

export enum StockTransferStatus {
  DRAFT = 'DRAFT',
  IN_TRANSIT = 'IN_TRANSIT',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

@Entity('stock_transfers')
export class StockTransfer extends BaseTenantEntity {
  @Column({ type: 'uuid' })
  source_warehouse_id!: string;

  @Column({ type: 'uuid' })
  destination_warehouse_id!: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: StockTransferStatus.DRAFT,
  })
  status!: StockTransferStatus;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  dispatched_at?: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  received_at?: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  cancelled_at?: Date | null;

  // Populated in queries with items
  items?: StockTransferItem[];
}

