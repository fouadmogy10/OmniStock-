import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateStockTransferItemDto {
  @IsNotEmpty()
  @IsUUID()
  product_id!: string;

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CreateStockTransferDto {
  @IsNotEmpty()
  @IsUUID()
  source_warehouse_id!: string;

  @IsNotEmpty()
  @IsUUID()
  destination_warehouse_id!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateStockTransferItemDto)
  items!: CreateStockTransferItemDto[];
}

