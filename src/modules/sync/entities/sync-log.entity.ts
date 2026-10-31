import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SyncAttempt } from './sync-attempt.entity';

export enum SyncStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  RETRY_SCHEDULED = 'RETRY_SCHEDULED',
  FAILED_PERMANENT = 'FAILED_PERMANENT',
}

@Entity('sync_logs')
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @Column({ type: 'varchar', length: 50 })
  source!: string;

  @Column({ type: 'varchar', length: 255 })
  external_id!: string;

  @Column({ type: 'varchar', length: 100 })
  event_type!: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: SyncStatus.PENDING,
  })
  status!: SyncStatus;

  @Column({ type: 'int', default: 0 })
  attempt_count!: number;

  @Column({ type: 'int', default: 5 })
  max_attempts!: number;

  @Column({ type: 'timestamp with time zone', nullable: true })
  next_retry_at?: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  next_trigger_source?: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  processing_started_at?: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lease_expires_at?: Date | null;

  @Column({ type: 'uuid', nullable: true })
  lease_token?: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  active_trigger_source?: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  last_pg_sqlstate?: string | null;

  @Column({ type: 'int', nullable: true })
  last_http_status?: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  last_error_code?: string | null;

  @Column({ type: 'text', nullable: true })
  last_error_message?: string | null;

  @Column({ type: 'uuid', nullable: true })
  order_id?: string | null;

  @Column({ type: 'jsonb' })
  payload!: Record<string, any>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  last_attempted_at?: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  completed_at?: Date | null;

  @CreateDateColumn({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  updated_at!: Date;

  // Populated in queries
  attempts?: SyncAttempt[];
}
