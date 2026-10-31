import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum SyncAttemptStatus {
  SUCCEEDED = 'SUCCEEDED',
  FAILED_RETRYABLE = 'FAILED_RETRYABLE',
  FAILED_PERMANENT = 'FAILED_PERMANENT',
}

export enum SyncTriggerSource {
  WEBHOOK = 'WEBHOOK',
  AUTO_RETRY = 'AUTO_RETRY',
  MANUAL_RETRY = 'MANUAL_RETRY',
}

@Entity('sync_attempts')
export class SyncAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @Column({ type: 'uuid' })
  sync_log_id!: string;

  @Column({ type: 'int' })
  attempt_number!: number;

  @Column({ type: 'uuid' })
  lease_token!: string;

  @Column({ type: 'varchar', length: 50 })
  trigger_source!: string;

  @Column({ type: 'varchar', length: 50 })
  status!: SyncAttemptStatus;

  @Column({ type: 'varchar', length: 10, nullable: true })
  pg_sqlstate?: string | null;

  @Column({ type: 'int', nullable: true })
  http_status?: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  error_code?: string | null;

  @Column({ type: 'text', nullable: true })
  error_message?: string | null;

  @CreateDateColumn({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  started_at!: Date;

  @Column({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  finished_at!: Date;

  @Column({ type: 'int', default: 0 })
  duration_ms!: number;
}

