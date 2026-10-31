import { IsString, IsNotEmpty, IsEmail, MinLength, IsEnum } from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole } from '../entities/user.entity';

export class CreateUserDto {
  @IsEmail()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password!: string;

  @IsEnum(UserRole, {
    message: 'role must be one of: ADMIN, MANAGER, VIEWER',
  })
  @IsNotEmpty()
  role!: UserRole;
}
