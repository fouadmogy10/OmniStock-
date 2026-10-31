import { Entity, Column } from 'typeorm';
import { BaseTenantEntity } from '../../../common/entities/base.entity';

@Entity('products')
export class Product extends BaseTenantEntity {
  @Column({ type: 'uuid', nullable: true })
  category_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  parent_product_id?: string | null;

  @Column({ type: 'boolean', default: false })
  is_variant_parent!: boolean;

  @Column({ type: 'varchar', length: 100 })
  sku!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  barcode?: string | null;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  variant_attributes?: Record<string, any> | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0.0 })
  price!: number;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  // Virtual property populated on GET /products/:id when is_variant_parent = true
  variants?: Product[];
}
