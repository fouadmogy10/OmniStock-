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
import { CategoryService } from './category.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { RequirePermissions, Permission } from '../../common/decorators/permissions.decorator';

@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Post()
  @RequirePermissions(Permission.CATEGORIES_WRITE)
  @HttpCode(HttpStatus.CREATED)
  async createCategory(@Body() dto: CreateCategoryDto, @Req() req: any) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.categoryService.createCategory(tenantId, actorUserId, dto);
  }

  @Get()
  @RequirePermissions(Permission.CATEGORIES_READ)
  async getCategories(@Req() req: any) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.categoryService.getCategories(tenantId);
  }

  @Patch(':id')
  @RequirePermissions(Permission.CATEGORIES_WRITE)
  async updateCategory(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.categoryService.updateCategory(tenantId, actorUserId, id, dto);
  }
}
