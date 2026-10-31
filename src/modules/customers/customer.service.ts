import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Customer } from './entities/customer.entity';
import { CreateCustomerDto, UpdateCustomerDto, FindCustomersQuery } from './dto/customer.dto';
import { AuditLogService } from '../audit/audit.service';

@Injectable()
export class CustomerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createCustomer(
    tenantId: string,
    actorUserId: string,
    dto: CreateCustomerDto,
  ): Promise<Customer> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const normalizedEmail = dto.email ? dto.email.toLowerCase().trim() : null;
      const phone = dto.phone ? dto.phone.trim() : null;

      if (normalizedEmail) {
        const existingEmail = await qr.manager.findOne(Customer, {
          where: { tenant_id: tenantId, email: normalizedEmail },
        });
        if (existingEmail) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'DUPLICATE_CUSTOMER_EMAIL',
            message: 'A customer with this email already exists in this tenant',
          });
        }
      }

      if (phone) {
        const existingPhone = await qr.manager.findOne(Customer, {
          where: { tenant_id: tenantId, phone },
        });
        if (existingPhone) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'DUPLICATE_CUSTOMER_PHONE',
            message: 'A customer with this phone number already exists in this tenant',
          });
        }
      }

      const customer = qr.manager.create(Customer, {
        tenant_id: tenantId,
        name: dto.name.trim(),
        email: normalizedEmail,
        phone,
      });

      const saved = await qr.manager.save(Customer, customer);

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'CUSTOMER_CREATED',
          entityType: 'Customer',
          entityId: saved.id,
          metadata: { name: saved.name, email: saved.email, phone: saved.phone },
        },
        qr.manager,
      );

      await qr.commitTransaction();
      return saved;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getCustomers(
    tenantId: string,
    query: FindCustomersQuery,
  ): Promise<{ data: Customer[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = (page - 1) * limit;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const qb = qr.manager
        .createQueryBuilder(Customer, 'c')
        .where('c.tenant_id = :tenantId', { tenantId });

      if (query.email) {
        qb.andWhere('lower(c.email) = lower(:email)', { email: query.email.trim() });
      }

      if (query.phone) {
        qb.andWhere('c.phone = :phone', { phone: query.phone.trim() });
      }

      if (query.search) {
        const searchPattern = `%${query.search.trim().toLowerCase()}%`;
        qb.andWhere(
          '(lower(c.name) LIKE :search OR lower(c.email) LIKE :search OR c.phone LIKE :search)',
          { search: searchPattern },
        );
      }

      qb.orderBy('c.created_at', 'DESC').addOrderBy('c.id', 'DESC');
      qb.skip(offset).take(limit);

      const [data, total] = await qb.getManyAndCount();
      await qr.commitTransaction();

      return { data, total, page, limit };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getCustomerById(tenantId: string, id: string): Promise<Customer> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const customer = await qr.manager.findOne(Customer, {
        where: { tenant_id: tenantId, id },
      });

      if (!customer) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'CUSTOMER_NOT_FOUND',
          message: `Customer ${id} not found in this tenant`,
        });
      }

      await qr.commitTransaction();
      return customer;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async updateCustomer(
    tenantId: string,
    actorUserId: string,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const customer = await qr.manager.findOne(Customer, {
        where: { tenant_id: tenantId, id },
      });

      if (!customer) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'CUSTOMER_NOT_FOUND',
          message: `Customer ${id} not found in this tenant`,
        });
      }

      const normalizedEmail =
        dto.email !== undefined ? (dto.email ? dto.email.toLowerCase().trim() : null) : undefined;
      const phone = dto.phone !== undefined ? (dto.phone ? dto.phone.trim() : null) : undefined;

      if (normalizedEmail !== undefined && normalizedEmail !== null) {
        const existingEmail = await qr.manager
          .createQueryBuilder(Customer, 'c')
          .where('c.tenant_id = :tenantId', { tenantId })
          .andWhere('lower(c.email) = lower(:email)', { email: normalizedEmail })
          .andWhere('c.id != :id', { id })
          .getOne();

        if (existingEmail) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'DUPLICATE_CUSTOMER_EMAIL',
            message: 'A customer with this email already exists in this tenant',
          });
        }
      }

      if (phone !== undefined && phone !== null) {
        const existingPhone = await qr.manager
          .createQueryBuilder(Customer, 'c')
          .where('c.tenant_id = :tenantId', { tenantId })
          .andWhere('c.phone = :phone', { phone })
          .andWhere('c.id != :id', { id })
          .getOne();

        if (existingPhone) {
          throw new ConflictException({
            statusCode: 409,
            error_code: 'DUPLICATE_CUSTOMER_PHONE',
            message: 'A customer with this phone number already exists in this tenant',
          });
        }
      }

      if (dto.name !== undefined) {
        customer.name = dto.name.trim();
      }
      if (normalizedEmail !== undefined) {
        customer.email = normalizedEmail;
      }
      if (phone !== undefined) {
        customer.phone = phone;
      }

      const updated = await qr.manager.save(Customer, customer);

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'CUSTOMER_UPDATED',
          entityType: 'Customer',
          entityId: updated.id,
          metadata: { name: updated.name, email: updated.email, phone: updated.phone },
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
