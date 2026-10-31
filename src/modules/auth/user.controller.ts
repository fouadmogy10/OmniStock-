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
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Permission } from '../../common/decorators/permissions.decorator';
import { UserRole } from './entities/user.entity';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @RequirePermissions(Permission.USERS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Body() dto: CreateUserDto, @Req() req: any) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.userService.createUser(tenantId, actorUserId, dto);
  }

  @Get()
  @RequirePermissions(Permission.USERS_READ)
  async getUsers(
    @Req() req: any,
    @Query('role') role?: UserRole,
    @Query('is_active') isActiveStr?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const is_active = isActiveStr === 'true' ? true : isActiveStr === 'false' ? false : undefined;

    return await this.userService.getUsers(tenantId, {
      role,
      is_active,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.USERS_READ)
  async getUserById(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.userService.getUserById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.USERS_MANAGE)
  async updateUser(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.userService.updateUser(tenantId, actorUserId, id, dto);
  }
}
