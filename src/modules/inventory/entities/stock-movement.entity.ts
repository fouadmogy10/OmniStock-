import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum StockMovementType {
  ADJUSTMENT = 'ADJUSTMENT',
  SALE = 'SALE',
  TRANSFER = 'TRANSFER',
  RETURN = 'RETURN', // Reserved enum value in MVP
}

@Entity('stock_movements')
export class StockMovement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @Column({ type: 'uuid' })
  product_id!: string;

  @Column({ type: 'uuid' })
  warehouse_id!: string;

  @Column({ type: 'int' })
  delta!: number;

  @Column({
    type: 'varchar',
    length: 50,
  })
  type!: StockMovementType;

  @Column({ type: 'uuid', nullable: true })
  reference_id?: string | null;

  @CreateDateColumn({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  created_at!: Date;
}

