import { Injectable, Logger } from '@nestjs/common';
import { DataSource, Repository, EntityManager } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';

export interface RecordTenantAuditParams {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, any>;
}

/**
 * AuditLogService
 *
 * Centralized audit logging service supporting:
 * 1. Attributable tenant activity logging under standard RLS.
 * 2. Unattributable pre-authentication failure logging via the SECURITY DEFINER function
 *    `public.record_pre_auth_audit_log(text, jsonb)` owned by `omnistock_preauth_auditor`.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Records a tenant-attributable audit log entry under active tenant context.
   * If an active EntityManager is provided (e.g. from an encompassing transaction),
   * the log entry is saved using that manager. Otherwise, it sets up its own transaction
   * and SET LOCAL app.current_tenant_id.
   */
  async recordTenantAudit(
    params: RecordTenantAuditParams,
    manager?: EntityManager,
  ): Promise<AuditLog> {
    if (manager) {
      const entry = manager.create(AuditLog, {
        tenant_id: params.tenantId,
        actor_user_id: params.actorUserId || null,
        action: params.action,
        entity_type: params.entityType,
        entity_id: params.entityId || null,
        metadata: params.metadata || null,
      });
      return await manager.save(entry);
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${params.tenantId}';`);

      const entry = qr.manager.create(AuditLog, {
        tenant_id: params.tenantId,
        actor_user_id: params.actorUserId || null,
        action: params.action,
        entity_type: params.entityType,
        entity_id: params.entityId || null,
        metadata: params.metadata || null,
      });

      const saved = await qr.manager.save(entry);
      await qr.commitTransaction();
      return saved;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  /**
   * Records an unattributable pre-authentication security event (tenant_id IS NULL).
   * Executed exclusively via `public.record_pre_auth_audit_log(p_action, p_metadata)`
   * owned by `omnistock_preauth_auditor`.
   */
  async recordPreAuthAudit(
    action: 'AUTH_LOGIN_FAILURE' | 'AUTH_TOKEN_INVALID' | 'SYNC_WEBHOOK_AUTH_FAILURE',
    metadata?: Record<string, any>,
  ): Promise<string> {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      const [result] = await queryRunner.query(
        `SELECT public.record_pre_auth_audit_log($1, $2) as id;`,
        [action, JSON.stringify(metadata || {})],
      );
      return result.id;
    } catch (err) {
      this.logger.error(`Failed to record pre-auth audit log for action ${action}:`, err);
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * List tenant-scoped audit logs with optional filters and pagination.
   */
  async getAuditLogs(
    tenantId: string,
    query: {
      action?: string;
      entity_type?: string;
      entity_id?: string;
      actor_user_id?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{ data: AuditLog[]; page: number; limit: number; total: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = (page - 1) * limit;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const conditions: string[] = ['tenant_id = $1'];
      const params: any[] = [tenantId];
      let paramIdx = 2;

      if (query.action) {
        conditions.push(`action = $${paramIdx++}`);
        params.push(query.action);
      }
      if (query.entity_type) {
        conditions.push(`entity_type = $${paramIdx++}`);
        params.push(query.entity_type);
      }
      if (query.entity_id) {
        conditions.push(`entity_id = $${paramIdx++}`);
        params.push(query.entity_id);
      }
      if (query.actor_user_id) {
        conditions.push(`actor_user_id = $${paramIdx++}`);
        params.push(query.actor_user_id);
      }
      if (query.from) {
        conditions.push(`created_at >= $${paramIdx++}`);
        params.push(new Date(query.from));
      }
      if (query.to) {
        conditions.push(`created_at <= $${paramIdx++}`);
        params.push(new Date(query.to));
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await qr.query(
        `SELECT COUNT(*) as total FROM audit_logs WHERE ${whereClause};`,
        params,
      );
      const total = parseInt(countResult[0]?.total || '0', 10);

      const rows = await qr.query(
        `SELECT id, tenant_id, actor_user_id, action, entity_type, entity_id, metadata, created_at
         FROM audit_logs
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++};`,
        [...params, limit, offset],
      );

      await qr.commitTransaction();

      return {
        data: rows,
        page,
        limit,
        total,
      };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
