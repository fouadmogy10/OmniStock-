import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isNotZero', async: false })
export class IsNotZeroConstraint implements ValidatorConstraintInterface {
  validate(value: any) {
    return typeof value === 'number' && value !== 0;
  }
  defaultMessage(args: ValidationArguments) {
    return `${args.property} cannot be 0`;
  }
}

export class AdjustStockDto {
  @IsNotEmpty()
  @IsUUID()
  product_id!: string;

  @IsNotEmpty()
  @IsUUID()
  warehouse_id!: string;

  @IsNotEmpty()
  @IsInt()
  @Validate(IsNotZeroConstraint)
  delta!: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class UpdateThresholdDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  low_stock_threshold?: number | null;
}

