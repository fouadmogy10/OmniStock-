import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration T040: Database Constraints & Immutability Triggers Migration
 *
 * Implements:
 * 1. Inventory non-negative and derived integrity constraints on inventory_items, low_stock_alerts,
 *    warehouses, products, stock_transfers, orders, order_allocations, sync credentials, and sync logs.
 * 2. Immutable BEFORE UPDATE OR DELETE triggers on append-only tables:
 *    - `stock_movements` (via `prevent_stock_movement_mutation()`)
 *    - `audit_logs` (via `prevent_audit_log_mutation()`)
 *    - `sync_attempts` (via `prevent_sync_attempt_mutation()`)
 *
 * Owned and executed by: `omnistock_migrator`
 */
export class DatabaseConstraintsAndTriggers1730376200000 implements MigrationInterface {
  name = 'DatabaseConstraintsAndTriggers1730376200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. inventory_items constraints
    await queryRunner.query(`
      ALTER TABLE inventory_items
        ADD CONSTRAINT chk_inventory_on_hand_non_negative CHECK (on_hand >= 0),
        ADD CONSTRAINT chk_inventory_reserved_non_negative CHECK (reserved >= 0),
        ADD CONSTRAINT chk_inventory_in_transit_non_negative CHECK (in_transit >= 0),
        ADD CONSTRAINT chk_inventory_reserved_lte_on_hand CHECK (reserved <= on_hand),
        ADD CONSTRAINT chk_inventory_low_stock_threshold CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0);
    `);

    // 2. low_stock_alerts constraints
    await queryRunner.query(`
      ALTER TABLE low_stock_alerts
        ADD CONSTRAINT chk_low_stock_threshold_non_negative CHECK (threshold >= 0),
        ADD CONSTRAINT chk_low_stock_available_non_negative CHECK (current_available >= 0),
        ADD CONSTRAINT chk_low_stock_status_resolved CHECK (
          (status = 'OPEN' AND resolved_at IS NULL) OR
          (status = 'RESOLVED' AND resolved_at IS NOT NULL)
        );
    `);

    // 3. stock_movements constraints
    await queryRunner.query(`
      ALTER TABLE stock_movements
        ADD CONSTRAINT chk_stock_movement_delta_nonzero CHECK (delta <> 0);
    `);

    // 4. warehouses constraints
    await queryRunner.query(`
      ALTER TABLE warehouses
        ADD CONSTRAINT chk_warehouse_priority_gte_one CHECK (priority >= 1);
    `);

    // 5. products constraints
    await queryRunner.query(`
      ALTER TABLE products
        ADD CONSTRAINT chk_products_variant_hierarchy CHECK (NOT (is_variant_parent = true AND parent_product_id IS NOT NULL)),
        ADD CONSTRAINT chk_products_price_non_negative CHECK (price >= 0);
    `);

    // 6. stock_transfers constraints
    await queryRunner.query(`
      ALTER TABLE stock_transfers
        ADD CONSTRAINT chk_stock_transfers_endpoints_distinct CHECK (source_warehouse_id <> destination_warehouse_id);
    `);

    // 7. stock_transfer_items & order_items constraints
    await queryRunner.query(`
      ALTER TABLE stock_transfer_items
        ADD CONSTRAINT chk_transfer_items_quantity_positive CHECK (quantity > 0);

      ALTER TABLE order_items
        ADD CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0);
    `);

    // 8. order_allocations constraints
    await queryRunner.query(`
      ALTER TABLE order_allocations
        ADD CONSTRAINT chk_allocations_quantity_positive CHECK (allocated_quantity > 0);
    `);

    // 9. sync_webhook_credentials constraints
    await queryRunner.query(`
      ALTER TABLE sync_webhook_credentials
        ADD CONSTRAINT chk_sync_credentials_secret_hash CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
        ADD CONSTRAINT chk_sync_credentials_encrypted_secret CHECK (encrypted_secret ~ '^[0-9a-f]{128}$'),
        ADD CONSTRAINT chk_sync_credentials_encryption_iv CHECK (encryption_iv ~ '^[0-9a-f]{24}$'),
        ADD CONSTRAINT chk_sync_credentials_encryption_auth_tag CHECK (encryption_auth_tag ~ '^[0-9a-f]{32}$'),
        ADD CONSTRAINT chk_sync_credentials_key_version CHECK (encryption_key_version >= 1),
        ADD CONSTRAINT chk_sync_credentials_revoked_consistency CHECK (
          (is_active = true AND revoked_at IS NULL) OR
          (is_active = false AND revoked_at IS NOT NULL)
        );
    `);

    // 10. sync_logs constraints
    await queryRunner.query(`
      ALTER TABLE sync_logs
        ADD CONSTRAINT chk_sync_logs_attempt_count_bounds CHECK (attempt_count >= 0 AND attempt_count <= max_attempts),
        ADD CONSTRAINT chk_sync_logs_max_attempts_is_five CHECK (max_attempts = 5),
        ADD CONSTRAINT chk_sync_logs_last_http_status CHECK (last_http_status IS NULL OR (last_http_status >= 100 AND last_http_status <= 599)),
        ADD CONSTRAINT chk_sync_logs_retry_scheduled_consistency CHECK (
          (status = 'RETRY_SCHEDULED' AND next_retry_at IS NOT NULL AND next_trigger_source IS NOT NULL AND attempt_count >= 1 AND attempt_count < max_attempts) OR
          (status <> 'RETRY_SCHEDULED' AND next_retry_at IS NULL AND next_trigger_source IS NULL)
        ),
        ADD CONSTRAINT chk_sync_logs_processing_consistency CHECK (
          (status = 'PROCESSING' AND processing_started_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_token IS NOT NULL AND active_trigger_source IS NOT NULL AND attempt_count >= 1) OR
          (status <> 'PROCESSING' AND processing_started_at IS NULL AND lease_expires_at IS NULL AND lease_token IS NULL AND active_trigger_source IS NULL)
        ),
        ADD CONSTRAINT chk_sync_logs_succeeded_consistency CHECK (
          (status = 'SUCCEEDED' AND order_id IS NOT NULL AND completed_at IS NOT NULL) OR
          (status <> 'SUCCEEDED' AND order_id IS NULL AND completed_at IS NULL)
        );
    `);

    // 11. sync_attempts constraints
    await queryRunner.query(`
      ALTER TABLE sync_attempts
        ADD CONSTRAINT chk_sync_attempts_attempt_number CHECK (attempt_number >= 1 AND attempt_number <= 5),
        ADD CONSTRAINT chk_sync_attempts_duration_non_negative CHECK (duration_ms >= 0),
        ADD CONSTRAINT chk_sync_attempts_http_status CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599)),
        ADD CONSTRAINT chk_sync_attempts_succeeded_error_consistency CHECK (
          (status = 'SUCCEEDED' AND error_code IS NULL AND error_message IS NULL AND pg_sqlstate IS NULL AND http_status IS NULL) OR
          (status <> 'SUCCEEDED' AND error_code IS NOT NULL)
        );
    `);

    // 12. Immutability Triggers on Append-Only Tables
    await queryRunner.query(`
      -- A. stock_movements immutability
      CREATE OR REPLACE FUNCTION public.prevent_stock_movement_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'StockMovement is an append-only ledger; updates and deletes are strictly prohibited'
          USING ERRCODE = 'restrict_violation';
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_prevent_stock_movement_mutation ON stock_movements;
      CREATE TRIGGER trg_prevent_stock_movement_mutation
        BEFORE UPDATE OR DELETE ON stock_movements
        FOR EACH ROW
        EXECUTE FUNCTION public.prevent_stock_movement_mutation();

      -- B. audit_logs immutability
      CREATE OR REPLACE FUNCTION public.prevent_audit_log_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'AuditLog is an append-only security log; updates and deletes are strictly prohibited'
          USING ERRCODE = 'restrict_violation';
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_prevent_audit_log_mutation ON audit_logs;
      CREATE TRIGGER trg_prevent_audit_log_mutation
        BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW
        EXECUTE FUNCTION public.prevent_audit_log_mutation();

      -- C. sync_attempts immutability
      CREATE OR REPLACE FUNCTION public.prevent_sync_attempt_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'SyncAttempt is an append-only history record; updates and deletes are strictly prohibited'
          USING ERRCODE = 'restrict_violation';
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_prevent_sync_attempt_mutation ON sync_attempts;
      CREATE TRIGGER trg_prevent_sync_attempt_mutation
        BEFORE UPDATE OR DELETE ON sync_attempts
        FOR EACH ROW
        EXECUTE FUNCTION public.prevent_sync_attempt_mutation();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_prevent_sync_attempt_mutation ON sync_attempts;`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.prevent_sync_attempt_mutation();`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_prevent_audit_log_mutation ON audit_logs;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.prevent_audit_log_mutation();`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_prevent_stock_movement_mutation ON stock_movements;`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.prevent_stock_movement_mutation();`);
  }
}
