import {
  Injectable,
  OnModuleInit,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { SyncWebhookCredential } from './entities/sync-webhook-credential.entity';
import { CreateSyncCredentialDto } from './dto/sync-credential.dto';
import { AuditLogService } from '../audit/audit.service';

export interface KeyringEntry {
  version: number;
  key: Buffer;
}

@Injectable()
export class SyncCredentialService implements OnModuleInit {
  private currentKeyVersion!: number;
  private keyring = new Map<number, Buffer>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  onModuleInit(): void {
    this.validateAndLoadKeyring();
  }

  /**
   * Validates WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION and WEBHOOK_SECRET_ENCRYPTION_KEYS
   * at application startup per F7-CRYPTO-1.
   */
  public validateAndLoadKeyring(): void {
    const currentVersionStr = process.env.WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION;
    if (!currentVersionStr || !/^\d+$/.test(currentVersionStr.trim())) {
      throw new Error(
        'WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION must be a positive integer >= 1',
      );
    }
    const currentVersion = parseInt(currentVersionStr.trim(), 10);
    if (currentVersion < 1) {
      throw new Error(
        'WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION must be a positive integer >= 1',
      );
    }

    const rawKeyring = process.env.WEBHOOK_SECRET_ENCRYPTION_KEYS;
    if (!rawKeyring || !rawKeyring.trim()) {
      throw new Error(
        'WEBHOOK_SECRET_ENCRYPTION_KEYS is required and must contain <version>:<64-hex-chars>',
      );
    }

    const entries = rawKeyring.split(',').map((s) => s.trim()).filter(Boolean);
    if (entries.length === 0) {
      throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEYS cannot be empty');
    }

    const newKeyring = new Map<number, Buffer>();

    for (const entry of entries) {
      const parts = entry.split(':');
      if (parts.length !== 2) {
        throw new Error(
          `Invalid keyring entry format: "${entry}". Expected "<version>:<64-hex-chars>"`,
        );
      }

      const versionNum = parseInt(parts[0].trim(), 10);
      const hexKey = parts[1].trim();

      if (isNaN(versionNum) || versionNum < 1) {
        throw new Error(`Invalid key version in keyring: "${parts[0]}"`);
      }

      if (newKeyring.has(versionNum)) {
        throw new Error(`Duplicate key version in keyring: ${versionNum}`);
      }

      // Explicit validation against /^[0-9a-f]{64}$/ before calling Buffer.from
      if (!/^[0-9a-f]{64}$/.test(hexKey)) {
        throw new Error(
          `Key for version ${versionNum} is invalid. Must be exactly 64 lowercase hex characters matching /^[0-9a-f]{64}$/`,
        );
      }

      const keyBuf = Buffer.from(hexKey, 'hex');
      if (keyBuf.byteLength !== 32) {
        throw new Error(`Decoded AES-256 key for version ${versionNum} must be exactly 32 bytes`);
      }

      newKeyring.set(versionNum, keyBuf);
    }

    if (!newKeyring.has(currentVersion)) {
      throw new Error(
        `Current key version ${currentVersion} is missing from WEBHOOK_SECRET_ENCRYPTION_KEYS`,
      );
    }

    this.currentKeyVersion = currentVersion;
    this.keyring = newKeyring;
  }

  public getCurrentKeyVersion(): number {
    return this.currentKeyVersion;
  }

  public getKeyByVersion(version: number): Buffer | undefined {
    return this.keyring.get(version);
  }

  async createCredential(
    tenantId: string,
    actorUserId: string,
    dto: CreateSyncCredentialDto,
  ): Promise<{
    id: string;
    tenant_id: string;
    source: string;
    is_active: boolean;
    webhook_secret: string;
    created_at: Date;
    revoked_at?: Date | null;
  }> {
    const source = dto.source ? dto.source.trim().toLowerCase() : '';
    if (!source) {
      throw new BadRequestException({
        statusCode: 400,
        error_code: 'VALIDATION_ERROR',
        message: 'Source is required',
      });
    }

    const currentKeyBuf = this.keyring.get(this.currentKeyVersion);
    if (!currentKeyBuf) {
      throw new Error(`Active key version ${this.currentKeyVersion} not available in keyring`);
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      // 1. Lock existing active credential for this tenant & source
      const existing = await qr.manager.findOne(SyncWebhookCredential, {
        where: {
          tenant_id: tenantId,
          source,
          is_active: true,
        },
      });

      if (existing) {
        existing.is_active = false;
        existing.revoked_at = new Date();
        await qr.manager.save(SyncWebhookCredential, existing);

        await this.auditLogService.recordTenantAudit(
          {
            tenantId,
            actorUserId,
            action: 'SYNC_CREDENTIAL_REVOKED',
            entityType: 'SyncWebhookCredential',
            entityId: existing.id,
            metadata: { source, reason: 'ROTATED' },
          },
          qr.manager,
        );
      }

      // 2. Generate 32 CSPRNG bytes -> 64-char lowercase hex webhook_secret
      const webhookSecret = crypto.randomBytes(32).toString('hex');
      const secretHash = crypto
        .createHash('sha256')
        .update(Buffer.from(webhookSecret, 'utf8'))
        .digest('hex');

      // 3. Encrypt Buffer.from(webhookSecret, 'utf8') with AES-256-GCM
      let savedCred: SyncWebhookCredential | null = null;
      let attempts = 0;
      const maxAttempts = 3;

      while (!savedCred && attempts < maxAttempts) {
        attempts++;
        const ivBuf = crypto.randomBytes(12);
        const ivHex = ivBuf.toString('hex');

        const cipher = crypto.createCipheriv('aes-256-gcm', currentKeyBuf, ivBuf);
        const aad = Buffer.from(`${tenantId}:${source}:${this.currentKeyVersion}`, 'utf8');
        cipher.setAAD(aad);

        const ciphertextBuf = Buffer.concat([
          cipher.update(Buffer.from(webhookSecret, 'utf8')),
          cipher.final(),
        ]);
        const authTagHex = cipher.getAuthTag().toString('hex');
        const encryptedSecretHex = ciphertextBuf.toString('hex');

        try {
          const credEntity = qr.manager.create(SyncWebhookCredential, {
            tenant_id: tenantId,
            source,
            secret_hash: secretHash,
            encrypted_secret: encryptedSecretHex,
            encryption_iv: ivHex,
            encryption_auth_tag: authTagHex,
            encryption_key_version: this.currentKeyVersion,
            is_active: true,
            revoked_at: null,
          });

          savedCred = await qr.manager.save(SyncWebhookCredential, credEntity);
        } catch (dbErr: any) {
          if (
            dbErr.code === '23505' &&
            dbErr.message &&
            dbErr.message.includes('uq_sync_credentials_key_iv')
          ) {
            // Nonce collision, retry with fresh nonce
            continue;
          }
          throw dbErr;
        }
      }

      if (!savedCred) {
        throw new ConflictException({
          statusCode: 409,
          error_code: 'ENCRYPTION_COLLISION',
          message: 'Failed to generate unique nonce after multiple attempts',
        });
      }

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'SYNC_CREDENTIAL_CREATED',
          entityType: 'SyncWebhookCredential',
          entityId: savedCred.id,
          metadata: {
            source,
            key_version: this.currentKeyVersion,
          },
        },
        qr.manager,
      );

      await qr.commitTransaction();

      return {
        id: savedCred.id,
        tenant_id: savedCred.tenant_id,
        source: savedCred.source,
        is_active: savedCred.is_active,
        webhook_secret: webhookSecret,
        created_at: savedCred.created_at,
        revoked_at: savedCred.revoked_at,
      };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getCredentials(tenantId: string): Promise<
    {
      id: string;
      tenant_id: string;
      source: string;
      is_active: boolean;
      created_at: Date;
      revoked_at?: Date | null;
    }[]
  > {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const creds = await qr.manager.find(SyncWebhookCredential, {
        where: { tenant_id: tenantId },
        order: { created_at: 'DESC' },
      });

      await qr.commitTransaction();

      return creds.map((c) => ({
        id: c.id,
        tenant_id: c.tenant_id,
        source: c.source,
        is_active: c.is_active,
        created_at: c.created_at,
        revoked_at: c.revoked_at,
      }));
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async revokeCredential(
    tenantId: string,
    actorUserId: string,
    id: string,
  ): Promise<{
    id: string;
    tenant_id: string;
    source: string;
    is_active: boolean;
    created_at: Date;
    revoked_at?: Date | null;
  }> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);

      const cred = await qr.manager.findOne(SyncWebhookCredential, {
        where: { tenant_id: tenantId, id },
      });

      if (!cred) {
        throw new NotFoundException({
          statusCode: 404,
          error_code: 'CREDENTIAL_NOT_FOUND',
          message: `Webhook credential ${id} not found in this tenant`,
        });
      }

      cred.is_active = false;
      cred.revoked_at = new Date();
      const updated = await qr.manager.save(SyncWebhookCredential, cred);

      await this.auditLogService.recordTenantAudit(
        {
          tenantId,
          actorUserId,
          action: 'SYNC_CREDENTIAL_REVOKED',
          entityType: 'SyncWebhookCredential',
          entityId: updated.id,
          metadata: { source: updated.source },
        },
        qr.manager,
      );

      await qr.commitTransaction();

      return {
        id: updated.id,
        tenant_id: updated.tenant_id,
        source: updated.source,
        is_active: updated.is_active,
        created_at: updated.created_at,
        revoked_at: updated.revoked_at,
      };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  decryptSecret(credential: SyncWebhookCredential): string {
    const keyBuf = this.keyring.get(credential.encryption_key_version);
    if (!keyBuf) {
      throw new Error(`Key version ${credential.encryption_key_version} missing from keyring`);
    }

    const ivBuf = Buffer.from(credential.encryption_iv, 'hex');
    const authTagBuf = Buffer.from(credential.encryption_auth_tag, 'hex');
    const ciphertextBuf = Buffer.from(credential.encrypted_secret, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
    const aad = Buffer.from(
      `${credential.tenant_id}:${credential.source.toLowerCase()}:${credential.encryption_key_version}`,
      'utf8',
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(authTagBuf);

    const decryptedBuf = Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]);
    return decryptedBuf.toString('utf8');
  }

  async reencryptCredentialsToCurrentKeyVersion(tenantId?: string): Promise<number> {
    const currentKeyBuf = this.keyring.get(this.currentKeyVersion);
    if (!currentKeyBuf) {
      throw new Error(`Active key version ${this.currentKeyVersion} missing`);
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      if (tenantId) {
        await qr.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
      }

      const qb = qr.manager
        .createQueryBuilder(SyncWebhookCredential, 'c')
        .where('c.encryption_key_version != :curVersion', { curVersion: this.currentKeyVersion });

      if (tenantId) {
        qb.andWhere('c.tenant_id = :tenantId', { tenantId });
      }

      const outdated = await qb.getMany();
      let rotatedCount = 0;

      for (const cred of outdated) {
        const plainSecret = this.decryptSecret(cred);
        const newIvBuf = crypto.randomBytes(12);
        const newCipher = crypto.createCipheriv('aes-256-gcm', currentKeyBuf, newIvBuf);
        const newAad = Buffer.from(
          `${cred.tenant_id}:${cred.source.toLowerCase()}:${this.currentKeyVersion}`,
          'utf8',
        );
        newCipher.setAAD(newAad);

        const newCiphertext = Buffer.concat([
          newCipher.update(Buffer.from(plainSecret, 'utf8')),
          newCipher.final(),
        ]);

        cred.encrypted_secret = newCiphertext.toString('hex');
        cred.encryption_iv = newIvBuf.toString('hex');
        cred.encryption_auth_tag = newCipher.getAuthTag().toString('hex');
        cred.encryption_key_version = this.currentKeyVersion;

        await qr.manager.save(SyncWebhookCredential, cred);
        rotatedCount++;
      }

      await qr.commitTransaction();
      return rotatedCount;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}

