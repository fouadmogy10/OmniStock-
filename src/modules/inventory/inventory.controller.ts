import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { AdjustStockDto, UpdateThresholdDto } from './dto/inventory.dto';
import { RequirePermissions, Permission } from '../../common/decorators/permissions.decorator';
import { StockMovementType } from './entities/stock-movement.entity';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('adjust')
  @RequirePermissions(Permission.INVENTORY_ADJUST)
  @HttpCode(HttpStatus.OK)
  async adjustStock(@Body() dto: AdjustStockDto, @Req() req: any) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.inventoryService.adjustStock(tenantId, actorUserId, dto);
  }

  @Get('levels')
  @RequirePermissions(Permission.INVENTORY_READ)
  async getLevels(
    @Req() req: any,
    @Query('sku') sku?: string,
    @Query('product_id') product_id?: string,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('low_stock_only') lowStockOnlyStr?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const low_stock_only = lowStockOnlyStr === 'true' ? true : undefined;

    return await this.inventoryService.getLevels(tenantId, {
      sku,
      product_id,
      warehouse_id,
      low_stock_only,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Patch('items/:id/threshold')
  @RequirePermissions(Permission.INVENTORY_THRESHOLD)
  async updateThreshold(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateThresholdDto,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.inventoryService.updateThreshold(
      tenantId,
      actorUserId,
      id,
      dto.low_stock_threshold,
    );
  }

  @Get('movements')
  @RequirePermissions(Permission.MOVEMENTS_READ)
  async getMovements(
    @Req() req: any,
    @Query('product_id') product_id?: string,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('type') type?: StockMovementType,
    @Query('reference_id') reference_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.inventoryService.getMovements(tenantId, {
      product_id,
      warehouse_id,
      type,
      reference_id,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}

