import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateProductDto {
  @IsNotEmpty()
  @IsString()
  sku!: string;

  @IsOptional()
  @IsString()
  barcode?: string | null;

  @IsNotEmpty()
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsUUID()
  category_id?: string | null;

  @IsOptional()
  @IsUUID()
  parent_product_id?: string | null;

  @IsOptional()
  @IsBoolean()
  is_variant_parent?: boolean;

  @IsOptional()
  @IsObject()
  variant_attributes?: Record<string, any> | null;

  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  price!: number;
}

export class UpdateProductDto {
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  barcode?: string | null;

  @IsOptional()
  @IsUUID()
  category_id?: string | null;

  @IsOptional()
  @IsObject()
  variant_attributes?: Record<string, any> | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsUUID()
  parent_product_id?: string | null;

  @IsOptional()
  @IsBoolean()
  is_variant_parent?: boolean;
}

