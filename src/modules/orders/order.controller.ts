import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { OrderService } from './order.service';
import { CreateOrderDto, UpdateOrderDto } from './dto/order.dto';
import { OrderStatus } from './entities/order.entity';
import { RequirePermissions, Permission } from '../../common/decorators/permissions.decorator';

@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  @RequirePermissions(Permission.ORDERS_WRITE)
  async createOrder(@Req() req: any, @Body() dto: CreateOrderDto) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.orderService.create(tenantId, actorUserId, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.ORDERS_WRITE)
  async updateDraft(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateOrderDto,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.orderService.updateDraft(tenantId, actorUserId, id, dto);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDERS_WRITE)
  async submitOrder(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.orderService.submit(tenantId, actorUserId, id);
  }

  @Post(':id/allocate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDERS_ALLOCATE)
  async allocateOrder(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.orderService.allocate(tenantId, actorUserId, id);
  }

  @Post(':id/ship')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDERS_SHIP)
  async shipOrder(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.orderService.ship(tenantId, actorUserId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDERS_CANCEL)
  async cancelOrder(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.orderService.cancel(tenantId, actorUserId, id);
  }

  @Get()
  @RequirePermissions(Permission.ORDERS_READ)
  async getOrders(
    @Req() req: any,
    @Query('status') status?: OrderStatus,
    @Query('customer_id') customer_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.orderService.getOrders(tenantId, {
      status,
      customer_id,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.ORDERS_READ)
  async getOrderById(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.orderService.getOrderById(tenantId, id);
  }
}
