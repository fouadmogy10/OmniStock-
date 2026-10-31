import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { User } from './entities/user.entity';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { AuthController } from './auth.controller';
import { UserController } from './user.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.register({
      secret:
        process.env.JWT_SECRET || 'super_secret_jwt_key_at_least_32_bytes_long_entropy_dev_only',
      signOptions: { expiresIn: '1h' },
    }),
    AuditModule,
  ],
  controllers: [AuthController, UserController],
  providers: [AuthService, UserService],
  exports: [AuthService, UserService, JwtModule, TypeOrmModule],
})
export class AuthModule {}
