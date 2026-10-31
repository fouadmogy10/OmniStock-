import { Controller, Get, Param, Query, Req, ParseUUIDPipe } from '@nestjs/common';
import { LowStockAlertService } from './low-stock-alert.service';
import { RequirePermissions, Permission } from '../../common/decorators/permissions.decorator';
import { LowStockAlertStatus } from './entities/low-stock-alert.entity';

@Controller('alerts/low-stock')
export class LowStockAlertController {
  constructor(private readonly alertService: LowStockAlertService) {}

  @Get()
  @RequirePermissions(Permission.ALERTS_READ)
  async getAlerts(
    @Req() req: any,
    @Query('status') status?: LowStockAlertStatus,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('product_id') product_id?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.alertService.getAlerts(tenantId, {
      status,
      warehouse_id,
      product_id,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.ALERTS_READ)
  async getAlertById(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.alertService.getAlertById(tenantId, id);
  }
}
