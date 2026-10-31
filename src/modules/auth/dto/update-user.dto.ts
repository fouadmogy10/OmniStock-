import { IsEnum, IsBoolean, IsOptional } from 'class-validator';
import { UserRole } from '../entities/user.entity';

export class UpdateUserDto {
  @IsOptional()
  @IsEnum(UserRole, {
    message: 'role must be one of: ADMIN, MANAGER, VIEWER',
  })
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
