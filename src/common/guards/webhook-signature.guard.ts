import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { SyncCredentialService } from '../../modules/sync/sync-credential.service';
import { AuditLogService } from '../../modules/audit/audit.service';
import { Tenant } from '../../modules/tenant/entities/tenant.entity';
import { SyncWebhookCredential } from '../../modules/sync/entities/sync-webhook-credential.entity';
import { RateLimiterService } from '../services/rate-limiter.service';

@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly syncCredentialService: SyncCredentialService,
    private readonly auditLogService: AuditLogService,
    private readonly rateLimiterService?: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const sourceParam = req.params?.source;
    const source = sourceParam ? String(sourceParam).trim().toLowerCase() : '';

    const tenantSlug = req.headers['x-sync-tenant-slug'];
    const externalId = req.headers['x-sync-external-id'];
    const timestampStr = req.headers['x-sync-timestamp'];
    const signatureHeader = req.headers['x-sync-signature'];

    // 1. Basic header existence and rawBody checks
    if (
      !tenantSlug ||
      typeof tenantSlug !== 'string' ||
      !externalId ||
      typeof externalId !== 'string' ||
      !timestampStr ||
      typeof timestampStr !== 'string' ||
      !signatureHeader ||
      typeof signatureHeader !== 'string'
    ) {
      await this.auditLogService.recordPreAuthAudit('SYNC_WEBHOOK_AUTH_FAILURE', {
        reason: 'MISSING_REQUIRED_HEADERS',
        source,
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'WEBHOOK_AUTH_UNAUTHORIZED',
        message: 'Missing required webhook sync headers',
      });
    }

    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      await this.auditLogService.recordPreAuthAudit('SYNC_WEBHOOK_AUTH_FAILURE', {
        reason: 'RAW_BODY_UNAVAILABLE',
        source,
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'WEBHOOK_AUTH_UNAUTHORIZED',
        message: 'Raw body buffer is required for signature verification',
      });
    }

    // 2. Validate timestamp format and ±300s replay window
    if (!/^\d+$/.test(timestampStr.trim())) {
      await this.auditLogService.recordPreAuthAudit('SYNC_WEBHOOK_AUTH_FAILURE', {
        reason: 'MALFORMED_TIMESTAMP',
        source,
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'WEBHOOK_AUTH_UNAUTHORIZED',
        message: 'Timestamp must be a valid integer UNIX epoch seconds',
      });
    }

    const timestamp = parseInt(timestampStr.trim(), 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 300) {
      await this.auditLogService.recordPreAuthAudit('SYNC_WEBHOOK_AUTH_FAILURE', {
        reason: 'TIMESTAMP_OUT_OF_WINDOW',
        source,
        timestamp,
        server_now: now,
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'WEBHOOK_AUTH_UNAUTHORIZED',
        message: 'Webhook timestamp outside ±300s replay window',
      });
    }

    // 3. Validate signature header regex: ^v1=[0-9a-f]{64}$
    if (!/^v1=[0-9a-f]{64}$/.test(signatureHeader.trim())) {
      await this.auditLogService.recordPreAuthAudit('SYNC_WEBHOOK_AUTH_FAILURE', {
        reason: 'MALFORMED_SIGNATURE_FORMAT',
        source,
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'WEBHOOK_AUTH_UNAUTHORIZED',
        message: 'Signature header must match ^v1=[0-9a-f]{64}$',
      });
    }

    const providedSigHex = signatureHeader.trim().slice(3); // after 'v1='
    const providedSigBuf = Buffer.from(providedSigHex, 'hex');

    // 4. Resolve active tenant by slug
    const tenant = await this.dataSource.manager.findOne(Tenant, {
      where: { slug: tenantSlug.trim().toLowerCase(), is_active: true },
    });

    if (!tenant) {
      await this.auditLogService.recordPreAuthAudit('SYNC_WEBHOOK_AUTH_FAILURE', {
        reason: 'TENANT_NOT_FOUND_OR_INACTIVE',
        slug: tenantSlug,
        source,
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'WEBHOOK_AUTH_UNAUTHORIZED',
        message: 'Tenant not found or inactive',
      });
    }

    // 5. Query active SyncWebhookCredential for this tenant & source
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    let credential: SyncWebhookCredential | null = null;
    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenant.id}';`);

      credential = await qr.manager.findOne(SyncWebhookCredential, {
        where: {
          tenant_id: tenant.id,
          source,
          is_active: true,
        },
      });

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }

    if (!credential) {
      await this.auditLogService.recordTenantAudit({
        tenantId: tenant.id,
        action: 'SYNC_WEBHOOK_AUTH_FAILURE',
        entityType: 'SyncWebhookCredential',
        metadata: { reason: 'CREDENTIAL_NOT_FOUND', source },
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'WEBHOOK_AUTH_UNAUTHORIZED',
        message: `No active webhook credential for source ${source}`,
      });
    }

    // 6. Decrypt secret only in memory using the matching key version
    let plainSecret: string;
    try {
      plainSecret = this.syncCredentialService.decryptSecret(credential);
    } catch (decryptErr: any) {
      this.logger.error(`Webhook secret decryption failed: ${decryptErr.message}`);
      await this.auditLogService.recordTenantAudit({
        tenantId: tenant.id,
        action: 'SYNC_WEBHOOK_AUTH_FAILURE',
        entityType: 'SyncWebhookCredential',
        entityId: credential.id,
        metadata: { reason: 'DECRYPTION_FAILED', source },
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'WEBHOOK_AUTH_UNAUTHORIZED',
        message: 'Failed to decrypt webhook credential',
      });
    }

    // 7. Compute expected HMAC-SHA256 digest over req.rawBody bytes:
    // HMAC-SHA256(key = Buffer.from(webhook_secret, 'utf8'), message = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), req.rawBody]))
    const messageBuf = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), req.rawBody]);
    const expectedSigBuf = crypto
      .createHmac('sha256', Buffer.from(plainSecret, 'utf8'))
      .update(messageBuf)
      .digest();

    // 8. Equal-length pre-check before timingSafeEqual to avoid RangeError
    if (providedSigBuf.byteLength !== 32 || expectedSigBuf.byteLength !== 32) {
      await this.auditLogService.recordTenantAudit({
        tenantId: tenant.id,
        action: 'SYNC_WEBHOOK_AUTH_FAILURE',
        entityType: 'SyncWebhookCredential',
        entityId: credential.id,
        metadata: { reason: 'SIGNATURE_BYTE_LENGTH_MISMATCH', source },
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'WEBHOOK_AUTH_UNAUTHORIZED',
        message: 'Invalid signature length',
      });
    }

    const signaturesMatch = crypto.timingSafeEqual(providedSigBuf, expectedSigBuf);
    if (!signaturesMatch) {
      await this.auditLogService.recordTenantAudit({
        tenantId: tenant.id,
        action: 'SYNC_WEBHOOK_AUTH_FAILURE',
        entityType: 'SyncWebhookCredential',
        entityId: credential.id,
        metadata: { reason: 'SIGNATURE_MISMATCH', source },
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error_code: 'WEBHOOK_AUTH_UNAUTHORIZED',
        message: 'Invalid webhook signature',
      });
    }

    // 9. Tier 2 Post-HMAC Authenticated Tenant Rate Limit
    if (this.rateLimiterService) {
      const res = context.switchToHttp().getResponse();
      const maxTenant = parseInt(process.env.RATE_LIMIT_WEBHOOK_TENANT_MAX || '120', 10);
      const ttl = parseInt(process.env.RATE_LIMIT_TTL_SECONDS || '60', 10);
      const tenantKey = `webhook:tenant:${tenant.id}:${source}`;
      this.rateLimiterService.consumeOrThrow(tenantKey, maxTenant, ttl, res);
    }

    // Attach verified tenant and context
    req.verifiedTenant = tenant;
    req.verifiedTenantId = tenant.id;
    req.verifiedSource = source;
    req.verifiedExternalId = externalId.trim();

    return true;
  }
}
