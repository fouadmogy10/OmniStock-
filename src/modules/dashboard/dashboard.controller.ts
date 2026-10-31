import { Controller, Get, Query, Req } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { RequirePermissions, Permission } from '../../common/decorators/permissions.decorator';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @RequirePermissions(Permission.DASHBOARD_READ)
  async getSummary(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.dashboardService.getSummary(tenantId, {
      from,
      to,
      warehouse_id,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}

