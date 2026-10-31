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
import { ProductService } from './product.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { RequirePermissions, Permission } from '../../common/decorators/permissions.decorator';

@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post()
  @RequirePermissions(Permission.PRODUCTS_WRITE)
  @HttpCode(HttpStatus.CREATED)
  async createProduct(@Body() dto: CreateProductDto, @Req() req: any) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.productService.createProduct(tenantId, actorUserId, dto);
  }

  @Get()
  @RequirePermissions(Permission.PRODUCTS_READ)
  async getProducts(
    @Req() req: any,
    @Query('sku') sku?: string,
    @Query('barcode') barcode?: string,
    @Query('category_id') category_id?: string,
    @Query('parent_product_id') parent_product_id?: string,
    @Query('is_variant_parent') isVariantParentStr?: string,
    @Query('is_active') isActiveStr?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const is_variant_parent =
      isVariantParentStr === 'true' ? true : isVariantParentStr === 'false' ? false : undefined;
    const is_active = isActiveStr === 'true' ? true : isActiveStr === 'false' ? false : undefined;

    return await this.productService.getProducts(tenantId, {
      sku,
      barcode,
      category_id,
      parent_product_id,
      is_variant_parent,
      is_active,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.PRODUCTS_READ)
  async getProductById(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.productService.getProductById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.PRODUCTS_WRITE)
  async updateProduct(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.productService.updateProduct(tenantId, actorUserId, id, dto);
  }
}

