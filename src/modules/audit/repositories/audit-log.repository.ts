import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindManyOptions } from 'typeorm';
import { AuditLog } from '../entities/audit-log.entity';

/**
 * AuditLogRepository
 *
 * Append-only repository for audit logging (FR-003, T042).
 * Exposes only insert and query capabilities, complementing database-level
 * BEFORE UPDATE OR DELETE trigger enforcement.
 */
@Injectable()
export class AuditLogRepository {
  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  /**
   * Append a new audit log entry.
   */
  async createAndSave(entry: Partial<AuditLog>): Promise<AuditLog> {
    const auditLog = this.repo.create(entry);
    return await this.repo.save(auditLog);
  }

  /**
   * Find audit logs for the current tenant context.
   */
  async find(options?: FindManyOptions<AuditLog>): Promise<AuditLog[]> {
    return await this.repo.find(options);
  }

  /**
   * Find audit logs and total count with pagination.
   */
  async findAndCount(options?: FindManyOptions<AuditLog>): Promise<[AuditLog[], number]> {
    return await this.repo.findAndCount(options);
  }

  /**
   * Find a single audit log by ID.
   */
  async findById(id: string): Promise<AuditLog | null> {
    return await this.repo.findOne({ where: { id } });
  }
}
