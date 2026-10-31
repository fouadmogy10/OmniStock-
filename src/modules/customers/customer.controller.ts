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
} from '@nestjs/common';
import { CustomerService } from './customer.service';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer.dto';
import { RequirePermissions, Permission } from '../../common/decorators/permissions.decorator';

@Controller('customers')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Post()
  @RequirePermissions(Permission.CUSTOMERS_WRITE)
  async createCustomer(@Req() req: any, @Body() dto: CreateCustomerDto) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.customerService.createCustomer(tenantId, actorUserId, dto);
  }

  @Get()
  @RequirePermissions(Permission.CUSTOMERS_READ)
  async getCustomers(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('email') email?: string,
    @Query('phone') phone?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.customerService.getCustomers(tenantId, {
      search,
      email,
      phone,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.CUSTOMERS_READ)
  async getCustomerById(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.customerService.getCustomerById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.CUSTOMERS_WRITE)
  async updateCustomer(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.customerService.updateCustomer(tenantId, actorUserId, id, dto);
  }
}
