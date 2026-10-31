import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration T038: Initial Schema Migration
 * Creates the global root `tenants` table and all 17 tenant-owned tables with explicit
 * composite UNIQUE constraints, SQL foreign keys (with ON DELETE RESTRICT where required),
 * and performance/uniqueness indexes.
 *
 * Owned and executed by: `omnistock_migrator`
 */
export class InitialSchema1730376000000 implements MigrationInterface {
  name = 'InitialSchema1730376000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 0. Enable pgcrypto for UUID generation if needed
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    // 1. Global root entity: tenants
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_lower_slug ON tenants (lower(slug));
      CREATE INDEX IF NOT EXISTS idx_tenants_active_id ON tenants (is_active, id ASC);
    `);

    // 2. users (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_users_tenant_email UNIQUE (tenant_id, email),
        CONSTRAINT uq_users_tenant_id UNIQUE (tenant_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_users_tenant_active ON users (tenant_id, is_active);
    `);

    // 3. audit_logs (tenant-owned / pre-auth security events)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
        actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(100) NOT NULL,
        entity_id UUID,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at DESC);
    `);

    // 4. customers (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(50),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_customers_tenant_id UNIQUE (tenant_id, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_tenant_email ON customers (tenant_id, lower(email)) WHERE email IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_tenant_phone ON customers (tenant_id, phone) WHERE phone IS NOT NULL;
    `);

    // 5. categories (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_categories_tenant_name UNIQUE (tenant_id, name),
        CONSTRAINT uq_categories_tenant_id UNIQUE (tenant_id, id)
      );
    `);

    // 6. products (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        category_id UUID,
        parent_product_id UUID,
        is_variant_parent BOOLEAN NOT NULL DEFAULT false,
        sku VARCHAR(100) NOT NULL,
        barcode VARCHAR(100),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        variant_attributes JSONB,
        price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_products_tenant_sku UNIQUE (tenant_id, sku),
        CONSTRAINT uq_products_tenant_id UNIQUE (tenant_id, id),
        CONSTRAINT fk_products_category FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id) ON DELETE SET NULL,
        CONSTRAINT fk_products_parent FOREIGN KEY (tenant_id, parent_product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_products_tenant_barcode ON products (tenant_id, barcode) WHERE barcode IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_products_tenant_active ON products (tenant_id, is_active, is_variant_parent);
    `);

    // 7. warehouses (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS warehouses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        name VARCHAR(255) NOT NULL,
        location VARCHAR(255),
        priority INTEGER NOT NULL DEFAULT 1,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_warehouses_tenant_name UNIQUE (tenant_id, name),
        CONSTRAINT uq_warehouses_tenant_id UNIQUE (tenant_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_warehouses_tenant_priority ON warehouses (tenant_id, priority ASC, is_active);
    `);

    // 8. inventory_items (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        product_id UUID NOT NULL,
        warehouse_id UUID NOT NULL,
        on_hand INTEGER NOT NULL DEFAULT 0,
        reserved INTEGER NOT NULL DEFAULT 0,
        in_transit INTEGER NOT NULL DEFAULT 0,
        low_stock_threshold INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_inventory_items_tenant_product_warehouse UNIQUE (tenant_id, product_id, warehouse_id),
        CONSTRAINT uq_inventory_items_tenant_id UNIQUE (tenant_id, id),
        CONSTRAINT uq_inventory_items_composite UNIQUE (tenant_id, id, product_id, warehouse_id),
        CONSTRAINT fk_inventory_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_warehouse FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant_product ON inventory_items (tenant_id, product_id);
    `);

    // 9. low_stock_alerts (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS low_stock_alerts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        inventory_item_id UUID NOT NULL,
        product_id UUID NOT NULL,
        warehouse_id UUID NOT NULL,
        threshold INTEGER NOT NULL,
        current_available INTEGER NOT NULL,
        status VARCHAR(50) NOT NULL,
        triggered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_low_stock_alerts_inventory FOREIGN KEY (tenant_id, inventory_item_id, product_id, warehouse_id)
          REFERENCES inventory_items(tenant_id, id, product_id, warehouse_id) ON DELETE RESTRICT,
        CONSTRAINT fk_low_stock_alerts_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_low_stock_alerts_warehouse FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_low_stock_alerts_open ON low_stock_alerts (tenant_id, inventory_item_id) WHERE status = 'OPEN';
      CREATE INDEX IF NOT EXISTS idx_low_stock_alerts_tenant_status ON low_stock_alerts (tenant_id, status);
    `);

    // 10. stock_movements (tenant-owned, append-only)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        product_id UUID NOT NULL,
        warehouse_id UUID NOT NULL,
        delta INTEGER NOT NULL,
        type VARCHAR(50) NOT NULL,
        reference_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_movements_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_movements_warehouse FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_product ON stock_movements (tenant_id, product_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_stock_movements_reference ON stock_movements (tenant_id, reference_id);
    `);

    // 11. stock_transfers (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS stock_transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        source_warehouse_id UUID NOT NULL,
        destination_warehouse_id UUID NOT NULL,
        status VARCHAR(50) NOT NULL,
        dispatched_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_stock_transfers_tenant_id UNIQUE (tenant_id, id),
        CONSTRAINT fk_transfers_source FOREIGN KEY (tenant_id, source_warehouse_id) REFERENCES warehouses(tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_transfers_dest FOREIGN KEY (tenant_id, destination_warehouse_id) REFERENCES warehouses(tenant_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_stock_transfers_tenant_status ON stock_transfers (tenant_id, status);
    `);

    // 12. stock_transfer_items (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS stock_transfer_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        stock_transfer_id UUID NOT NULL,
        product_id UUID NOT NULL,
        quantity INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_transfer_items_transfer FOREIGN KEY (tenant_id, stock_transfer_id) REFERENCES stock_transfers(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT fk_transfer_items_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT
      );
    `);

    // 13. orders (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        customer_id UUID NOT NULL,
        customer_name_snapshot VARCHAR(255) NOT NULL,
        customer_email_snapshot VARCHAR(255),
        status VARCHAR(50) NOT NULL,
        total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_orders_tenant_id UNIQUE (tenant_id, id),
        CONSTRAINT fk_orders_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_orders_tenant_status_created ON orders (tenant_id, status, created_at DESC);
    `);

    // 14. order_items (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        order_id UUID NOT NULL,
        product_id UUID NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price NUMERIC(12, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_order_items_tenant_id UNIQUE (tenant_id, id),
        CONSTRAINT uq_order_items_composite UNIQUE (tenant_id, id, order_id, product_id),
        CONSTRAINT fk_order_items_order FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT fk_order_items_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT
      );
    `);

    // 15. order_allocations (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS order_allocations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        order_id UUID NOT NULL,
        order_item_id UUID NOT NULL,
        product_id UUID NOT NULL,
        warehouse_id UUID NOT NULL,
        allocated_quantity INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_allocations_order_item FOREIGN KEY (tenant_id, order_item_id, order_id, product_id)
          REFERENCES order_items(tenant_id, id, order_id, product_id) ON DELETE CASCADE,
        CONSTRAINT fk_allocations_warehouse FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_allocations_order_id ON order_allocations (tenant_id, order_id);
    `);

    // 16. sync_webhook_credentials (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sync_webhook_credentials (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        source VARCHAR(50) NOT NULL,
        secret_hash VARCHAR(64) NOT NULL,
        encrypted_secret VARCHAR(128) NOT NULL,
        encryption_iv VARCHAR(24) NOT NULL,
        encryption_auth_tag VARCHAR(32) NOT NULL,
        encryption_key_version INTEGER NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMPTZ,
        CONSTRAINT uq_sync_credentials_tenant_id UNIQUE (tenant_id, id),
        CONSTRAINT uq_sync_credentials_key_iv UNIQUE (encryption_key_version, encryption_iv)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_credentials_active ON sync_webhook_credentials (tenant_id, lower(source)) WHERE is_active = true AND revoked_at IS NULL;
    `);

    // 17. sync_logs (tenant-owned)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sync_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        source VARCHAR(50) NOT NULL,
        external_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        status VARCHAR(50) NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_retry_at TIMESTAMPTZ,
        next_trigger_source VARCHAR(50),
        processing_started_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        lease_token UUID,
        active_trigger_source VARCHAR(50),
        last_pg_sqlstate VARCHAR(5),
        last_http_status INTEGER,
        last_error_code VARCHAR(100),
        last_error_message TEXT,
        order_id UUID,
        payload JSONB NOT NULL,
        last_attempted_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_sync_logs_tenant_id UNIQUE (tenant_id, id),
        CONSTRAINT uq_sync_logs_tenant_source_external UNIQUE (tenant_id, source, external_id),
        CONSTRAINT fk_sync_logs_order FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_sync_logs_claimable ON sync_logs (tenant_id, status, next_retry_at, attempt_count)
        WHERE status IN ('PENDING', 'RETRY_SCHEDULED');
      CREATE INDEX IF NOT EXISTS idx_sync_logs_lease_expired ON sync_logs (tenant_id, status, lease_expires_at)
        WHERE status = 'PROCESSING';
    `);

    // 18. sync_attempts (tenant-owned, append-only)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sync_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        sync_log_id UUID NOT NULL,
        attempt_number INTEGER NOT NULL,
        lease_token UUID,
        trigger_source VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL,
        pg_sqlstate VARCHAR(5),
        http_status INTEGER,
        error_code VARCHAR(100),
        error_message TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT fk_sync_attempts_log FOREIGN KEY (tenant_id, sync_log_id) REFERENCES sync_logs(tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT uq_sync_attempts_log_number UNIQUE (tenant_id, sync_log_id, attempt_number),
        CONSTRAINT uq_sync_attempts_log_lease UNIQUE (tenant_id, sync_log_id, lease_token)
      );
      CREATE INDEX IF NOT EXISTS idx_sync_attempts_log_id ON sync_attempts (tenant_id, sync_log_id, attempt_number ASC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sync_attempts CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS sync_logs CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS sync_webhook_credentials CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS order_allocations CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS order_items CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS orders CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS stock_transfer_items CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS stock_transfers CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS stock_movements CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS low_stock_alerts CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS inventory_items CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS warehouses CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS products CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS categories CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS customers CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS audit_logs CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS users CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS tenants CASCADE;`);
  }
}
