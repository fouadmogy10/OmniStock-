import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  Res,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { SyncCredentialService } from './sync-credential.service';
import { SyncService } from './sync.service';
import { SyncRetryService } from './sync-retry.service';
import { CreateSyncCredentialDto } from './dto/sync-credential.dto';
import { SyncStatus } from './entities/sync-log.entity';
import { RequirePermissions, Permission } from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { WebhookSignatureGuard } from '../../common/guards/webhook-signature.guard';

@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncCredentialService: SyncCredentialService,
    private readonly syncService: SyncService,
    private readonly syncRetryService: SyncRetryService,
  ) {}

  @Post('credentials')
  @RequirePermissions(Permission.SYNC_CREDENTIALS)
  async createCredential(@Req() req: any, @Body() dto: CreateSyncCredentialDto) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.syncCredentialService.createCredential(tenantId, actorUserId, dto);
  }

  @Get('credentials')
  @RequirePermissions(Permission.SYNC_CREDENTIALS)
  async getCredentials(@Req() req: any) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.syncCredentialService.getCredentials(tenantId);
  }

  @Post('credentials/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SYNC_CREDENTIALS)
  async revokeCredential(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.syncCredentialService.revokeCredential(tenantId, actorUserId, id);
  }

  @Post('webhook/:source')
  @Public()
  @UseGuards(WebhookSignatureGuard)
  async handleWebhook(
    @Req() req: any,
    @Res() res: Response,
    @Param('source') source: string,
    @Body() payload: any,
  ) {
    const tenantId = req.verifiedTenantId;
    const externalId = req.verifiedExternalId;
    const result = await this.syncService.handleInboundWebhook(
      tenantId,
      source,
      externalId,
      payload,
    );

    return res.status(result.status).json(result.syncLog);
  }

  @Get('logs')
  @RequirePermissions(Permission.SYNC_READ)
  async getSyncLogs(
    @Req() req: any,
    @Query('status') status?: SyncStatus,
    @Query('source') source?: string,
    @Query('external_id') external_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.syncRetryService.getSyncLogs(tenantId, {
      status,
      source,
      external_id,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('logs/:id')
  @RequirePermissions(Permission.SYNC_READ)
  async getSyncLogById(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    return await this.syncRetryService.getSyncLogById(tenantId, id);
  }

  @Post('logs/:id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(Permission.SYNC_RETRY)
  async retrySyncLog(@Req() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = req.authenticatedUser.tenant_id;
    const actorUserId = req.authenticatedUser.id;
    return await this.syncRetryService.retrySyncLog(tenantId, actorUserId, id);
  }
}
