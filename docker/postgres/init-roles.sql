-- ==============================================================================
-- OmniStock MVP: Cluster Role & Database Bootstrap Script
-- Executed once on PostgreSQL cluster initialization (/docker-entrypoint-initdb.d/)
-- ==============================================================================

-- 1. Create Dedicated Cluster Roles with Least Privileges
-- ------------------------------------------------------------------------------

-- Migration / Admin Role:
-- Owns schemas, tables, sequences, indexes, views, and RLS policies.
-- Used exclusively by the TypeORM migration CLI and test reset utilities.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'omnistock_migrator') THEN
        CREATE ROLE omnistock_migrator WITH LOGIN PASSWORD 'MigratorSecurePass123!' CREATEDB;
    END IF;
END
$$;

-- Runtime Application Role:
-- Strictly non-owner role with NOBYPASSRLS, NOSUPERUSER, NOCREATEDB, NOCREATEROLE.
-- Used exclusively by the NestJS application at runtime (DatabaseModule).
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'omnistock_app') THEN
        CREATE ROLE omnistock_app WITH LOGIN PASSWORD 'AppSecurePass123!' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$$;

-- Pre-Auth Security Auditor Role:
-- Dedicated NOLOGIN role owning the record_pre_auth_audit_log SECURITY DEFINER function.
-- Has zero access to any table other than INSERT on audit_logs for tenant_id IS NULL events.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'omnistock_preauth_auditor') THEN
        CREATE ROLE omnistock_preauth_auditor WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$$;

-- Allow omnistock_migrator to SET ROLE omnistock_preauth_auditor (required in PG16 to ALTER FUNCTION OWNER)
-- INHERIT FALSE ensures omnistock_migrator does not automatically inherit auditor privileges
GRANT omnistock_preauth_auditor TO omnistock_migrator WITH SET TRUE, INHERIT FALSE;

-- 2. Create Application Databases Owned by omnistock_migrator
-- ------------------------------------------------------------------------------

SELECT 'CREATE DATABASE omnistock OWNER omnistock_migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'omnistock')\gexec

SELECT 'CREATE DATABASE omnistock_test OWNER omnistock_migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'omnistock_test')\gexec

-- 3. Configure Schema Permissions on Primary Database
-- ------------------------------------------------------------------------------
\c omnistock

-- Revoke default CREATE privileges on public schema from PUBLIC
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Ensure omnistock_migrator owns public schema
ALTER SCHEMA public OWNER TO omnistock_migrator;

-- Grant USAGE to omnistock_app, and USAGE + CREATE to omnistock_preauth_auditor on public schema
-- omnistock_preauth_auditor needs CREATE on public to own functions in public schema
GRANT USAGE ON SCHEMA public TO omnistock_app;
GRANT USAGE, CREATE ON SCHEMA public TO omnistock_preauth_auditor;

-- Ensure omnistock_app cannot CREATE objects in public schema
REVOKE CREATE ON SCHEMA public FROM omnistock_app;

-- 4. Configure Schema Permissions on Test Database
-- ------------------------------------------------------------------------------
\c omnistock_test

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO omnistock_migrator;
GRANT USAGE ON SCHEMA public TO omnistock_app;
GRANT USAGE, CREATE ON SCHEMA public TO omnistock_preauth_auditor;
REVOKE CREATE ON SCHEMA public FROM omnistock_app;

