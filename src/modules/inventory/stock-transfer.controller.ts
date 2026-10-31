import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { StockTransferService } from './stock-transfer.service';
import { CreateStockTransferDto } from './dto/stock-transfer.dto';
import { RequirePermissions, Permission } from '../../common/decorators/permissions.decorator';
import { StockTransferStatus } from './entities/stock-transfer.entity';

@Controller('transfers')
export class StockTransferController {
  constructor(private readonly transferService: StockTransferService) {}

  @Post()
  @RequirePermissions(Permission.TRANSFERS_WRITE)
  @HttpCode(HttpStatus.CREATED)
  async createTransfer(@Body() dto: CreateStockTransferDto, @Req() req: any) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.transferService.createDraft(tenantId, actorUserId, dto);
  }

  @Post(':id/dispatch')
  @RequirePermissions(Permission.TRANSFERS_EXECUTE)
  @HttpCode(HttpStatus.OK)
  async dispatchTransfer(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.transferService.dispatch(tenantId, actorUserId, id);
  }

  @Post(':id/receive')
  @RequirePermissions(Permission.TRANSFERS_EXECUTE)
  @HttpCode(HttpStatus.OK)
  async receiveTransfer(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.transferService.receive(tenantId, actorUserId, id);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.TRANSFERS_WRITE)
  @HttpCode(HttpStatus.OK)
  async cancelTransfer(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.transferService.cancel(tenantId, actorUserId, id);
  }

  @Get()
  @RequirePermissions(Permission.TRANSFERS_READ)
  async getTransfers(
    @Req() req: any,
    @Query('status') status?: StockTransferStatus,
    @Query('source_warehouse_id') source_warehouse_id?: string,
    @Query('destination_warehouse_id') destination_warehouse_id?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.transferService.getTransfers(tenantId, {
      status,
      source_warehouse_id,
      destination_warehouse_id,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.TRANSFERS_READ)
  async getTransferById(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.transferService.getTransferById(tenantId, id);
  }
}

