import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('sync_webhook_credentials')
export class SyncWebhookCredential {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @Column({ type: 'varchar', length: 50 })
  source!: string;

  @Column({ type: 'varchar', length: 64 })
  secret_hash!: string;

  @Column({ type: 'varchar', length: 128 })
  encrypted_secret!: string;

  @Column({ type: 'varchar', length: 24 })
  encryption_iv!: string;

  @Column({ type: 'varchar', length: 32 })
  encryption_auth_tag!: string;

  @Column({ type: 'int' })
  encryption_key_version!: number;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @CreateDateColumn({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  created_at!: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  revoked_at?: Date | null;
}
