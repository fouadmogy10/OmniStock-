import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * AuditLog Entity (Foundational Phase 2 Entity)
 *
 * Implements security and critical business activity logging.
 * Uses scalar UUID columns for `tenant_id` and `actor_user_id` so that Phase 2
 * foundational audit logging compiles and operates independently of later User/Tenant entities.
 */
@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  tenant_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  actor_user_id!: string | null;

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'varchar', length: 100 })
  entity_type!: string;

  @Column({ type: 'uuid', nullable: true })
  entity_id!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  created_at!: Date;
}
