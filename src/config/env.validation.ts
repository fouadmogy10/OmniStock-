import * as crypto from 'crypto';

export interface EnvConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  LOG_LEVEL: 'info' | 'debug' | 'warn' | 'error';
  DB_HOST: string;
  DB_PORT: number;
  DB_NAME: string;
  DB_APP_USER: string;
  DB_APP_PASSWORD: string;
  DB_POOL_MAX: number;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION: number;
  WEBHOOK_SECRET_ENCRYPTION_KEYS: string;
  SYNC_WORKER_ENABLED: boolean;
  SYNC_WORKER_POLL_INTERVAL_MS: number;
  SYNC_WORKER_BATCH_SIZE: number;
  SHUTDOWN_DRAIN_TIMEOUT_MS: number;
  TRUSTED_PROXY_IPS: string[];
  RATE_LIMIT_TTL_SECONDS: number;
  RATE_LIMIT_TENANT_ONBOARD_MAX: number;
  RATE_LIMIT_LOGIN_MAX: number;
  RATE_LIMIT_LOGIN_IP_MAX: number;
  RATE_LIMIT_WEBHOOK_IP_MAX: number;
  RATE_LIMIT_WEBHOOK_SOURCE_IP_MAX: number;
  RATE_LIMIT_WEBHOOK_TENANT_MAX: number;
}

const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'changeme',
  'secret',
  'jwt_secret',
  'default',
  'development',
  'test',
  'password',
  'omnistock',
  'replace_me',
  'your-256-bit-secret',
  'super_secret_jwt_key_at_least_32_bytes_long_entropy_dev_only',
]);

/**
 * Validates process environment variables fail-closed per FR-019.
 */
export function validateEnv(config: Record<string, any>): EnvConfig {
  const nodeEnv = (config.NODE_ENV || 'development').trim().toLowerCase();
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error(
      `Invalid NODE_ENV: '${config.NODE_ENV}'. Must be development, test, or production.`,
    );
  }

  // 1. Prohibit migrator credentials in runtime application context
  if (config.DB_MIGRATOR_USER || config.DB_MIGRATOR_PASSWORD) {
    // Only fail if not in test CLI run where migrator credentials might be passed to CLI scripts
    if (process.env.STRICT_ISOLATION_CHECK === 'true') {
      throw new Error(
        'Security violation: DB_MIGRATOR_USER and DB_MIGRATOR_PASSWORD must not be loaded into runtime application configuration',
      );
    }
  }

  const dbAppUser = config.DB_APP_USER || 'omnistock_app';
  if (['omnistock_migrator', 'omnistock_preauth_auditor'].includes(dbAppUser)) {
    throw new Error(
      `Security violation: DB_APP_USER cannot be set to prohibited role '${dbAppUser}'`,
    );
  }

  // 2. Validate JWT_SECRET length and entropy
  const jwtSecret = config.JWT_SECRET;
  if (!jwtSecret || typeof jwtSecret !== 'string' || jwtSecret.trim() === '') {
    throw new Error('JWT_SECRET environment variable is missing or empty');
  }

  const jwtSecretBytes = Buffer.byteLength(jwtSecret, 'utf8');
  if (jwtSecretBytes < 32) {
    throw new Error(
      `JWT_SECRET length violation: Secret contains ${jwtSecretBytes} UTF-8 bytes; minimum 32 bytes required`,
    );
  }

  // Sanity check: not a repeated single character
  const firstChar = jwtSecret.charAt(0);
  const isRepeatedChar = jwtSecret.split('').every((c) => c === firstChar);
  if (isRepeatedChar) {
    throw new Error('JWT_SECRET cannot consist of a single repeated character');
  }

  if (nodeEnv === 'production') {
    const lowerSecret = jwtSecret.toLowerCase();
    for (const placeholder of KNOWN_PLACEHOLDER_SECRETS) {
      if (lowerSecret === placeholder || lowerSecret.includes(placeholder)) {
        throw new Error(
          `Production security violation: JWT_SECRET is using a known weak placeholder: '${jwtSecret}'`,
        );
      }
    }
  }

  // 3. Validate Webhook Secret Encryption Keyring
  const currentKeyVersionStr = config.WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION;
  const currentKeyVersion = parseInt(currentKeyVersionStr || '1', 10);
  if (isNaN(currentKeyVersion) || currentKeyVersion < 1) {
    throw new Error(
      `WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION must be a positive integer >= 1. Got: '${currentKeyVersionStr}'`,
    );
  }

  const encryptionKeysRaw = config.WEBHOOK_SECRET_ENCRYPTION_KEYS;
  if (
    !encryptionKeysRaw ||
    typeof encryptionKeysRaw !== 'string' ||
    encryptionKeysRaw.trim() === ''
  ) {
    throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEYS environment variable is missing or empty');
  }

  const parsedKeyring = new Map<number, Buffer>();
  const entries = encryptionKeysRaw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entries.length === 0) {
    throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEYS contains no valid key entries');
  }

  const HEX_KEY_REGEX = /^[0-9a-f]{64}$/;

  for (const entry of entries) {
    const parts = entry.split(':');
    if (parts.length !== 2) {
      throw new Error(`Invalid keyring entry format in WEBHOOK_SECRET_ENCRYPTION_KEYS: '${entry}'`);
    }
    const version = parseInt(parts[0].trim(), 10);
    const hexKey = parts[1].trim().toLowerCase();

    if (isNaN(version) || version < 1) {
      throw new Error(`Key version in keyring must be a positive integer >= 1. Got '${parts[0]}'`);
    }

    if (parsedKeyring.has(version)) {
      throw new Error(`Duplicate key version '${version}' found in WEBHOOK_SECRET_ENCRYPTION_KEYS`);
    }

    if (!HEX_KEY_REGEX.test(hexKey)) {
      throw new Error(
        `Key version ${version} has invalid key length or non-hex characters. Must be exactly 64 lowercase hex characters.`,
      );
    }

    const keyBuf = Buffer.from(hexKey, 'hex');
    if (keyBuf.byteLength !== 32) {
      throw new Error(`Decoded AES key for version ${version} must be exactly 32 bytes.`);
    }

    parsedKeyring.set(version, keyBuf);
  }

  if (!parsedKeyring.has(currentKeyVersion)) {
    throw new Error(
      `WEBHOOK_SECRET_ENCRYPTION_KEYS does not contain the active version ${currentKeyVersion}`,
    );
  }

  // 4. Parse Trusted Proxy IPs
  const trustedProxyRaw = config.TRUSTED_PROXY_IPS || '';
  const trustedProxyIps = trustedProxyRaw
    .split(',')
    .map((ip: string) => ip.trim())
    .filter((ip: string) => ip.length > 0);

  return {
    NODE_ENV: nodeEnv as any,
    PORT: parseInt(config.PORT || '3000', 10),
    LOG_LEVEL: config.LOG_LEVEL || 'info',
    DB_HOST: config.DB_HOST || 'localhost',
    DB_PORT: parseInt(config.DB_PORT || '5432', 10),
    DB_NAME: config.DB_NAME || 'omnistock',
    DB_APP_USER: dbAppUser,
    DB_APP_PASSWORD: config.DB_APP_PASSWORD || 'AppSecurePass123!',
    DB_POOL_MAX: parseInt(config.DB_POOL_MAX || '20', 10),
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: config.JWT_EXPIRES_IN || '1h',
    WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION: currentKeyVersion,
    WEBHOOK_SECRET_ENCRYPTION_KEYS: encryptionKeysRaw,
    SYNC_WORKER_ENABLED:
      config.SYNC_WORKER_ENABLED !== 'false' && config.SYNC_WORKER_ENABLED !== false,
    SYNC_WORKER_POLL_INTERVAL_MS: parseInt(config.SYNC_WORKER_POLL_INTERVAL_MS || '5000', 10),
    SYNC_WORKER_BATCH_SIZE: parseInt(config.SYNC_WORKER_BATCH_SIZE || '10', 10),
    SHUTDOWN_DRAIN_TIMEOUT_MS: parseInt(config.SHUTDOWN_DRAIN_TIMEOUT_MS || '15000', 10),
    TRUSTED_PROXY_IPS: trustedProxyIps,
    RATE_LIMIT_TTL_SECONDS: parseInt(config.RATE_LIMIT_TTL_SECONDS || '60', 10),
    RATE_LIMIT_TENANT_ONBOARD_MAX: parseInt(config.RATE_LIMIT_TENANT_ONBOARD_MAX || '5', 10),
    RATE_LIMIT_LOGIN_MAX: parseInt(config.RATE_LIMIT_LOGIN_MAX || '10', 10),
    RATE_LIMIT_LOGIN_IP_MAX: parseInt(config.RATE_LIMIT_LOGIN_IP_MAX || '30', 10),
    RATE_LIMIT_WEBHOOK_IP_MAX: parseInt(config.RATE_LIMIT_WEBHOOK_IP_MAX || '60', 10),
    RATE_LIMIT_WEBHOOK_SOURCE_IP_MAX: parseInt(
      config.RATE_LIMIT_WEBHOOK_SOURCE_IP_MAX || '120',
      10,
    ),
    RATE_LIMIT_WEBHOOK_TENANT_MAX: parseInt(config.RATE_LIMIT_WEBHOOK_TENANT_MAX || '120', 10),
  };
}
