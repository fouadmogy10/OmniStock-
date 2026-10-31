import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Tenant } from '../tenant/entities/tenant.entity';
import { User } from './entities/user.entity';
import { AuditLogService } from '../audit/audit.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Authenticate tenant user and generate tenant-scoped JWT.
   */
  async login(
    dto: LoginDto,
    clientIp?: string,
    userAgent?: string,
  ): Promise<{
    access_token: string;
    user: { id: string; tenant_id: string; email: string; role: string };
  }> {
    const slug = dto.tenant_slug.toLowerCase();
    const email = dto.email.toLowerCase();

    // 1. Resolve active tenant from global directory
    const tenant = await this.dataSource
      .getRepository(Tenant)
      .findOne({ where: { slug, is_active: true } });

    if (!tenant) {
      // Record unattributable pre-auth failure (tenant_id IS NULL)
      try {
        await this.auditLogService.recordPreAuthAudit('AUTH_LOGIN_FAILURE', {
          reason: 'Tenant not found or inactive',
          tenant_slug: slug,
          email,
          ip: clientIp,
          user_agent: userAgent,
        });
      } catch (err) {
        this.logger.warn(`Failed to record pre-auth audit: ${err}`);
      }

      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'AUTH_UNAUTHORIZED',
        message: 'Invalid credentials',
      });
    }

    // 2. Query user inside tenant-isolated transaction
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenant.id}';`);

      const [user] = await qr.query(
        `SELECT id, tenant_id, email, password_hash, role, is_active FROM users WHERE tenant_id = $1 AND lower(email) = $2;`,
        [tenant.id, email],
      );

      if (!user) {
        await this.auditLogService.recordTenantAudit(
          {
            tenantId: tenant.id,
            action: 'AUTH_LOGIN_FAILURE',
            entityType: 'Auth',
            metadata: { email, reason: 'User not found', ip: clientIp },
          },
          qr.manager,
        );

        throw new UnauthorizedException({
          statusCode: 401,
          error_code: 'AUTH_UNAUTHORIZED',
          message: 'Invalid credentials',
        });
      }

      // Check password
      const passwordMatch = await bcrypt.compare(dto.password, user.password_hash);
      if (!passwordMatch) {
        await this.auditLogService.recordTenantAudit(
          {
            tenantId: tenant.id,
            actorUserId: user.id,
            action: 'AUTH_LOGIN_FAILURE',
            entityType: 'Auth',
            metadata: { email, reason: 'Invalid password', ip: clientIp },
          },
          qr.manager,
        );

        throw new UnauthorizedException({
          statusCode: 401,
          error_code: 'AUTH_UNAUTHORIZED',
          message: 'Invalid credentials',
        });
      }

      // Check active status
      if (!user.is_active) {
        await this.auditLogService.recordTenantAudit(
          {
            tenantId: tenant.id,
            actorUserId: user.id,
            action: 'AUTH_LOGIN_FAILURE',
            entityType: 'Auth',
            metadata: { email, reason: 'User account deactivated', ip: clientIp },
          },
          qr.manager,
        );

        throw new UnauthorizedException({
          statusCode: 401,
          error_code: 'AUTH_UNAUTHORIZED',
          message: 'Account is deactivated',
        });
      }

      // Record successful login audit
      await this.auditLogService.recordTenantAudit(
        {
          tenantId: tenant.id,
          actorUserId: user.id,
          action: 'AUTH_LOGIN_SUCCESS',
          entityType: 'Auth',
          metadata: { ip: clientIp, user_agent: userAgent },
        },
        qr.manager,
      );

      await qr.commitTransaction();

      // Generate JWT
      const payload = {
        sub: user.id,
        tenant_id: tenant.id,
        role: user.role,
      };

      const accessToken = await this.jwtService.signAsync(payload, {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN || '1h',
      });

      return {
        access_token: accessToken,
        user: {
          id: user.id,
          tenant_id: user.tenant_id,
          email: user.email,
          role: user.role,
        },
      };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
