import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { HealthService } from './health.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  @Public()
  @HttpCode(HttpStatus.OK)
  getLive() {
    return this.healthService.getLive();
  }

  @Get('ready')
  @Public()
  @HttpCode(HttpStatus.OK)
  async getReady() {
    return await this.healthService.getReady();
  }
}
