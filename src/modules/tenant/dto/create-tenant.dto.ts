import { IsString, IsNotEmpty, IsEmail, MinLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase alphanumeric characters and hyphens',
  })
  slug!: string;

  @IsEmail()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  admin_email!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  admin_password!: string;
}
