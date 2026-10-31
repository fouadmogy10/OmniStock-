import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { CreateWarehouseDto, UpdateWarehouseDto } from './dto/warehouse.dto';
import { RequirePermissions, Permission } from '../../common/decorators/permissions.decorator';

@Controller('warehouses')
export class WarehouseController {
  constructor(private readonly warehouseService: WarehouseService) {}

  @Post()
  @RequirePermissions(Permission.WAREHOUSES_WRITE)
  @HttpCode(HttpStatus.CREATED)
  async createWarehouse(@Body() dto: CreateWarehouseDto, @Req() req: any) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.warehouseService.createWarehouse(tenantId, actorUserId, dto);
  }

  @Get()
  @RequirePermissions(Permission.WAREHOUSES_READ)
  async getWarehouses(@Req() req: any) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.warehouseService.getWarehouses(tenantId);
  }

  @Patch(':id')
  @RequirePermissions(Permission.WAREHOUSES_WRITE)
  async updateWarehouse(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.warehouseService.updateWarehouse(tenantId, actorUserId, id, dto);
  }
}
