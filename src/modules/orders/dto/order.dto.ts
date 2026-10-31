import {
  IsUUID,
  IsInt,
  Min,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsArray,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus } from '../entities/order.entity';

export class CreateOrderItemDto {
  @IsUUID()
  product_id!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unit_price?: number;
}

export class CreateOrderDto {
  @IsUUID()
  customer_id!: string;

  @IsOptional()
  @IsBoolean()
  auto_allocate?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];
}

export class UpdateOrderDto {
  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => CreateOrderItemDto)
  items?: CreateOrderItemDto[];
}

export interface FindOrdersQuery {
  status?: OrderStatus;
  customer_id?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

