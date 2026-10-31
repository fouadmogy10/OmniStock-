import { Controller, Post, Body, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { Public } from '../../common/decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: any) {
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip;
    const userAgent = req.headers['user-agent'] || 'unknown';
    return await this.authService.login(dto, String(clientIp), String(userAgent));
  }
}
