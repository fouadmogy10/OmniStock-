import { Entity, Column } from 'typeorm';
import { BaseTenantEntity } from '../../../common/entities/base.entity';

@Entity('warehouses')
export class Warehouse extends BaseTenantEntity {
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  location?: string | null;

  @Column({ type: 'int', default: 1 })
  priority!: number;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;
}

