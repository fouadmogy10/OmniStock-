import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum LowStockAlertStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

@Entity('low_stock_alerts')
export class LowStockAlert {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @Column({ type: 'uuid' })
  inventory_item_id!: string;

  @Column({ type: 'uuid' })
  product_id!: string;

  @Column({ type: 'uuid' })
  warehouse_id!: string;

  @Column({ type: 'int' })
  threshold!: number;

  @Column({ type: 'int' })
  current_available!: number;

  @Column({
    type: 'varchar',
    length: 50,
    default: LowStockAlertStatus.OPEN,
  })
  status!: LowStockAlertStatus;

  @CreateDateColumn({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  triggered_at!: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  resolved_at?: Date | null;

  @UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  updated_at!: Date;
}

