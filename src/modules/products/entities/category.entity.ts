import { Entity, Column } from 'typeorm';
import { BaseTenantEntity } from '../../../common/entities/base.entity';

@Entity('categories')
export class Category extends BaseTenantEntity {
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;
}

