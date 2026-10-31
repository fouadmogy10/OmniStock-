import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from './entities/user.entity';
import { AuditLogService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Create a new user within the active tenant.
   */
  async createUser(
    tenantId: string,
    actorUserId: string,
    dto: CreateUserDto,
  ): Promise<Omit<User, 'password_hash'>> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const email = dto.email.toLowerCase();

      // Check tenant-scoped email uniqueness
      const [existing] = await qr.query(
        `SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = $2;`,
        [tenantId, email],
      );

      if (existing) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'DUPLICATE_USER_EMAIL',
          message: 'User email already exists in tenant',
        });
      }

      const passwordHash = await bcrypt.hash(dto.password, 10);

      const user = qr.manager.create(User, {
        tenant_id: tenantId,
        email,
        password_hash: passwordHash,
        role: dto.role,
        is_active: true,
      });

      const savedUser = await qr.manager.save(user);

      // Record audit log
      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'USER_CREATED',
          entityType: 'User',
          entityId: savedUser.id,
          metadata: {
            email: savedUser.email,
            role: savedUser.role,
          },
        },
        qr.manager,
      );

      await qr.commitTransaction();

      const { password_hash, ...safeUser } = savedUser;
      return safeUser as Omit<User, 'password_hash'>;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  /**
   * List users in the active tenant with optional filtering and pagination.
   */
  async getUsers(
    tenantId: string,
    query: { role?: UserRole; is_active?: boolean; page?: number; limit?: number },
  ): Promise<{ data: Omit<User, 'password_hash'>[]; page: number; limit: number; total: number }> {
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

      if (query.role) {
        conditions.push(`role = $${paramIdx++}`);
        params.push(query.role);
      }

      if (query.is_active !== undefined) {
        conditions.push(`is_active = $${paramIdx++}`);
        params.push(query.is_active);
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await qr.query(
        `SELECT COUNT(*) as total FROM users WHERE ${whereClause};`,
        params,
      );
      const total = parseInt(countResult[0]?.total || '0', 10);

      const rows = await qr.query(
        `SELECT id, tenant_id, email, role, is_active, created_at, updated_at
         FROM users
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

  /**
   * Retrieve a single user by ID within the active tenant.
   */
  async getUserById(tenantId: string, userId: string): Promise<Omit<User, 'password_hash'>> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const [user] = await qr.query(
        `SELECT id, tenant_id, email, role, is_active, created_at, updated_at
         FROM users
         WHERE id = $1 AND tenant_id = $2;`,
        [userId, tenantId],
      );

      if (!user) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'USER_NOT_FOUND',
          message: 'User not found',
        });
      }

      await qr.commitTransaction();
      return user;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  /**
   * Update a tenant user with transactional last-active-ADMIN protection (T066).
   */
  async updateUser(
    tenantId: string,
    actorUserId: string,
    userId: string,
    dto: UpdateUserDto,
  ): Promise<Omit<User, 'password_hash'>> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      // 1. Lock target user row
      const [targetUser] = await qr.query(
        `SELECT id, tenant_id, email, role, is_active FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE;`,
        [userId, tenantId],
      );

      if (!targetUser) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'USER_NOT_FOUND',
          message: 'User not found',
        });
      }

      const isCurrentlyActiveAdmin =
        targetUser.role === UserRole.ADMIN && targetUser.is_active === true;
      const wouldDemote = dto.role !== undefined && dto.role !== UserRole.ADMIN;
      const wouldDeactivate = dto.is_active === false;

      // 2. Enforce LAST_ACTIVE_ADMIN_REQUIRED
      if (isCurrentlyActiveAdmin && (wouldDemote || wouldDeactivate)) {
        // Lock all active ADMIN rows in this tenant
        const activeAdmins = await qr.query(
          `SELECT id FROM users WHERE tenant_id = $1 AND role = 'ADMIN' AND is_active = true FOR UPDATE;`,
          [tenantId],
        );

        if (activeAdmins.length <= 1) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'LAST_ACTIVE_ADMIN_REQUIRED',
            message: 'Cannot demote or deactivate the last active admin of the tenant',
          });
        }
      }

      // 3. Apply updates
      const newRole = dto.role !== undefined ? dto.role : targetUser.role;
      const newIsActive = dto.is_active !== undefined ? dto.is_active : targetUser.is_active;

      const updateResult = await qr.query(
        `UPDATE users
         SET role = $1, is_active = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND tenant_id = $4
         RETURNING id, tenant_id, email, role, is_active, created_at, updated_at;`,
        [newRole, newIsActive, userId, tenantId],
      );

      // In PostgreSQL driver via TypeORM, UPDATE RETURNING can return [rows, rowCount] or rows
      const rows = Array.isArray(updateResult) && Array.isArray(updateResult[0])
        ? updateResult[0]
        : Array.isArray(updateResult)
          ? updateResult
          : [updateResult];
      const updated = rows[0];

      // 4. Record audit log
      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'USER_UPDATED',
          entityType: 'User',
          entityId: userId,
          metadata: {
            previous: { role: targetUser.role, is_active: targetUser.is_active },
            updated: { role: newRole, is_active: newIsActive },
          },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return updated;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
