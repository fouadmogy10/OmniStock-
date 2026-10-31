-- ==============================================================================
-- OmniStock MVP: Post-Restore Security & Integrity Verification Script
-- Task: T076 (specs/001-omnistock-mvp/tasks.md)
-- Usage: psql -v ON_ERROR_STOP=1 -h <host> -U omnistock_migrator -d <database> -f scripts/verify-restore.sql
-- ==============================================================================

DO $$
DECLARE
  v_tenant_tables text[] := ARRAY[
    'users', 'audit_logs', 'customers', 'categories', 'products',
    'warehouses', 'inventory_items', 'low_stock_alerts', 'stock_movements',
    'stock_transfers', 'stock_transfer_items', 'orders', 'order_items',
    'order_allocations', 'sync_webhook_credentials', 'sync_logs', 'sync_attempts'
  ];
  v_append_only_tables text[] := ARRAY[
    'stock_movements', 'audit_logs', 'sync_attempts'
  ];
  v_tbl text;
  v_row_security boolean;
  v_force_row_security boolean;
  v_policy_count integer;
  v_trigger_count integer;
  v_app_owns_count integer;
  v_disallowed_priv text;
  v_app_role_name text := 'omnistock_app';
BEGIN
  RAISE NOTICE '=== OmniStock Restore Verification Starting ===';

  -- 1. Check Row-Level Security (RLS) and FORCE RLS on all 17 tenant-owned tables
  FOREACH v_tbl IN ARRAY v_tenant_tables LOOP
    SELECT relrowsecurity, relforcerowsecurity
    INTO v_row_security, v_force_row_security
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_tbl;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Table public.% not found in restored database!', v_tbl;
    END IF;

    IF v_row_security IS NOT TRUE THEN
      RAISE EXCEPTION 'Table public.% lacks ENABLE ROW LEVEL SECURITY!', v_tbl;
    END IF;

    IF v_force_row_security IS NOT TRUE THEN
      RAISE EXCEPTION 'Table public.% lacks FORCE ROW LEVEL SECURITY!', v_tbl;
    END IF;

    -- Verify RLS policy exists for the table
    SELECT COUNT(*)
    INTO v_policy_count
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_tbl;

    IF v_policy_count = 0 THEN
      RAISE EXCEPTION 'Table public.% has no RLS policies defined!', v_tbl;
    END IF;

    RAISE NOTICE 'Verified RLS & policies on public.%: ENABLED=true, FORCED=true, POLICIES=%', v_tbl, v_policy_count;
  END LOOP;

  -- 2. Verify Immutability Triggers on Append-Only Tables
  FOREACH v_tbl IN ARRAY v_append_only_tables LOOP
    SELECT COUNT(*)
    INTO v_trigger_count
    FROM pg_trigger trg
    JOIN pg_class c ON c.oid = trg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_tbl
      AND trg.tgname LIKE 'trg_prevent_%_mutation';

    IF v_trigger_count = 0 THEN
      RAISE EXCEPTION 'Append-only table public.% is missing its immutability trigger!', v_tbl;
    END IF;

    RAISE NOTICE 'Verified immutability trigger on append-only table public.%', v_tbl;
  END LOOP;

  -- 3. Verify Least-Privilege Isolation for omnistock_app
  -- 3a. omnistock_app must NOT possess elevated cluster attributes
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = v_app_role_name
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole)
  ) THEN
    RAISE EXCEPTION 'Role % has elevated cluster privileges (SUPERUSER, BYPASSRLS, CREATEDB, or CREATEROLE)!', v_app_role_name;
  END IF;

  -- 3b. omnistock_app must NOT inherit or be a member of omnistock_migrator or omnistock_preauth_auditor
  IF pg_has_role(v_app_role_name, 'omnistock_migrator', 'MEMBER') THEN
    RAISE EXCEPTION 'Role % is an unauthorized member of omnistock_migrator!', v_app_role_name;
  END IF;

  IF pg_has_role(v_app_role_name, 'omnistock_preauth_auditor', 'MEMBER') THEN
    RAISE EXCEPTION 'Role % is an unauthorized member of omnistock_preauth_auditor!', v_app_role_name;
  END IF;

  -- 3c. omnistock_app must NOT own schema public or any tables
  IF has_schema_privilege(v_app_role_name, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Role % possesses unauthorized CREATE privilege on public schema!', v_app_role_name;
  END IF;

  SELECT COUNT(*)
  INTO v_app_owns_count
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND r.rolname = v_app_role_name;

  IF v_app_owns_count > 0 THEN
    RAISE EXCEPTION 'Role % owns % objects in public schema!', v_app_role_name, v_app_owns_count;
  END IF;

  -- 3d. omnistock_app must NOT hold UPDATE, DELETE, or TRUNCATE on append-only tables
  FOREACH v_tbl IN ARRAY v_append_only_tables LOOP
    IF has_table_privilege(v_app_role_name, 'public.' || v_tbl, 'UPDATE') THEN
      RAISE EXCEPTION 'Role % holds prohibited UPDATE privilege on append-only table public.%!', v_app_role_name, v_tbl;
    END IF;

    IF has_table_privilege(v_app_role_name, 'public.' || v_tbl, 'DELETE') THEN
      RAISE EXCEPTION 'Role % holds prohibited DELETE privilege on append-only table public.%!', v_app_role_name, v_tbl;
    END IF;

    IF has_table_privilege(v_app_role_name, 'public.' || v_tbl, 'TRUNCATE') THEN
      RAISE EXCEPTION 'Role % holds prohibited TRUNCATE privilege on append-only table public.%!', v_app_role_name, v_tbl;
    END IF;
  END LOOP;

  -- 3e. omnistock_app must NOT hold TRUNCATE on ANY table
  FOREACH v_tbl IN ARRAY array_cat(v_tenant_tables, ARRAY['tenants']) LOOP
    IF has_table_privilege(v_app_role_name, 'public.' || v_tbl, 'TRUNCATE') THEN
      RAISE EXCEPTION 'Role % holds prohibited TRUNCATE privilege on public.%!', v_app_role_name, v_tbl;
    END IF;
  END LOOP;

  RAISE NOTICE 'SUCCESS: All restore verification checks passed cleanly.';
  RAISE NOTICE '=== OmniStock Restore Verification Completed ===';
END $$;
