import { Controller, Post, Get, Body, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Permission } from '../../common/decorators/permissions.decorator';

@Controller('tenants')
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createTenant(@Body() dto: CreateTenantDto) {
    return await this.tenantService.createTenant(dto);
  }

  @Get('me')
  @RequirePermissions(Permission.TENANT_READ)
  async getTenantProfile(@Req() req: any) {
    const tenantId = req.authenticatedUser?.tenant_id || req.tenantId;
    return await this.tenantService.getTenantById(tenantId);
  }
}
