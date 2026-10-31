import { Injectable, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Tenant } from './entities/tenant.entity';
import { User, UserRole } from '../auth/entities/user.entity';
import { AuditLogService } from '../audit/audit.service';
import { CreateTenantDto } from './dto/create-tenant.dto';

@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Register a new tenant organization and its initial ADMIN user atomically.
   */
  async createTenant(dto: CreateTenantDto): Promise<{ tenant: Tenant; admin_user: Partial<User> }> {
    const existing = await this.tenantRepo.findOne({
      where: { slug: dto.slug.toLowerCase() },
    });

    if (existing) {
      throw new ConflictException({
        statusCode: 409,
        error_code: 'DUPLICATE_TENANT_SLUG',
        message: 'Tenant slug already exists',
      });
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // 1. Create global root Tenant row
      const tenant = qr.manager.create(Tenant, {
        name: dto.name,
        slug: dto.slug.toLowerCase(),
        is_active: true,
      });
      const savedTenant = await qr.manager.save(tenant);

      // 2. Set transaction-scoped tenant context
      await qr.query(`SET LOCAL app.current_tenant_id = '${savedTenant.id}';`);

      // 3. Hash admin password
      const passwordHash = await bcrypt.hash(dto.admin_password, 10);

      // 4. Create initial ADMIN user
      const adminUser = qr.manager.create(User, {
        tenant_id: savedTenant.id,
        email: dto.admin_email.toLowerCase(),
        password_hash: passwordHash,
        role: UserRole.ADMIN,
        is_active: true,
      });
      const savedAdmin = await qr.manager.save(adminUser);

      // 5. Record onboarding audit log
      await this.auditLogService.recordTenantAudit(
        {
          tenantId: savedTenant.id,
          actorUserId: savedAdmin.id,
          action: 'ADMIN_ACTION',
          entityType: 'Tenant',
          entityId: savedTenant.id,
          metadata: {
            action: 'TENANT_ONBOARDED',
            name: savedTenant.name,
            slug: savedTenant.slug,
            admin_email: savedAdmin.email,
          },
        },
        qr.manager,
      );

      await qr.commitTransaction();

      // Return sanitized admin user
      const { password_hash, ...adminSafe } = savedAdmin;

      return {
        tenant: savedTenant,
        admin_user: adminSafe,
      };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  /**
   * Retrieve current tenant profile by ID.
   */
  async getTenantById(id: string): Promise<Tenant> {
    const tenant = await this.tenantRepo.findOne({ where: { id } });
    if (!tenant) {
      throw new NotFoundException({
        statusCode: 404,
        error_code: 'TENANT_NOT_FOUND',
        message: 'Tenant not found',
      });
    }
    return tenant;
  }
}
