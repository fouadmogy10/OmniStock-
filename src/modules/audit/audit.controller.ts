import { Controller, Get, Query, Req } from '@nestjs/common';
import { AuditLogService } from './audit.service';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Permission } from '../../common/decorators/permissions.decorator';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @RequirePermissions(Permission.AUDIT_READ)
  async getAuditLogs(
    @Req() req: any,
    @Query('action') action?: string,
    @Query('entity_type') entity_type?: string,
    @Query('entity_id') entity_id?: string,
    @Query('actor_user_id') actor_user_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.auditLogService.getAuditLogs(tenantId, {
      action,
      entity_type,
      entity_id,
      actor_user_id,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
