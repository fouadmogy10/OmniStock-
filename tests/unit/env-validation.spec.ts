import { validateEnv } from '../../src/config/env.validation';

describe('Environment Validation Unit Tests (T074, FR-019)', () => {
  const baseValidConfig = {
    NODE_ENV: 'test',
    PORT: '3000',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_NAME: 'omnistock_test',
    DB_APP_USER: 'omnistock_app',
    DB_APP_PASSWORD: 'AppSecurePassword123!',
    JWT_SECRET: 'a_very_secure_test_jwt_secret_with_more_than_32_bytes!',
    WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION: '1',
    WEBHOOK_SECRET_ENCRYPTION_KEYS:
      '1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };

  it('accepts valid configuration', () => {
    const config = validateEnv(baseValidConfig);
    expect(config.PORT).toBe(3000);
    expect(config.JWT_SECRET).toBe(baseValidConfig.JWT_SECRET);
    expect(config.WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION).toBe(1);
  });

  describe('JWT_SECRET Validation', () => {
    it('fails closed when JWT_SECRET is missing or empty', () => {
      expect(() => validateEnv({ ...baseValidConfig, JWT_SECRET: '' })).toThrow(
        /JWT_SECRET environment variable is missing or empty/,
      );
    });

    it('fails closed when JWT_SECRET is under 32 UTF-8 bytes', () => {
      expect(() =>
        validateEnv({ ...baseValidConfig, JWT_SECRET: 'short_key_under_32_bytes' }),
      ).toThrow(
        /JWT_SECRET length violation: Secret contains \d+ UTF-8 bytes; minimum 32 bytes required/,
      );
    });

    it('fails closed when JWT_SECRET is a repeated single character', () => {
      const repeated = 'a'.repeat(35);
      expect(() => validateEnv({ ...baseValidConfig, JWT_SECRET: repeated })).toThrow(
        /JWT_SECRET cannot consist of a single repeated character/,
      );
    });

    it('fails closed in production on known placeholder secrets', () => {
      const placeholders = ['changeme', 'secret', 'jwt_secret', 'password', 'replace_me'];
      for (const placeholder of placeholders) {
        // Pad to >= 32 chars but containing placeholder
        const padded = placeholder + '_padding_for_32_bytes_length';
        // Test exact placeholder check
        expect(() =>
          validateEnv({
            ...baseValidConfig,
            NODE_ENV: 'production',
            JWT_SECRET: placeholder.padEnd(32, '!'),
          }),
        ).toThrow(/Production security violation: JWT_SECRET is using a known weak placeholder/);
      }
    });

    it('allows valid >= 32 bytes secret in production', () => {
      const strongProdSecret = 'b9a8f4c2e1d056789abcdef0123456789abcdef0123456789abcdef012345678';
      const config = validateEnv({
        ...baseValidConfig,
        NODE_ENV: 'production',
        JWT_SECRET: strongProdSecret,
      });
      expect(config.JWT_SECRET).toBe(strongProdSecret);
    });
  });

  describe('Webhook Keyring Validation', () => {
    it('fails closed when key does not match /^[0-9a-f]{64}$/', () => {
      expect(() =>
        validateEnv({
          ...baseValidConfig,
          WEBHOOK_SECRET_ENCRYPTION_KEYS: '1:INVALID_KEY_NOT_HEX_64_CHARS',
        }),
      ).toThrow(/invalid key length or non-hex characters/);
    });

    it('fails closed when current key version is missing from keyring', () => {
      expect(() =>
        validateEnv({
          ...baseValidConfig,
          WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION: '2',
          WEBHOOK_SECRET_ENCRYPTION_KEYS:
            '1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        }),
      ).toThrow(/does not contain the active version 2/);
    });

    it('fails closed on duplicate key version in keyring', () => {
      const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(() =>
        validateEnv({
          ...baseValidConfig,
          WEBHOOK_SECRET_ENCRYPTION_KEYS: `1:${hexKey},1:${hexKey}`,
        }),
      ).toThrow(/Duplicate key version '1'/);
    });

    it('fails closed when keyring is provided as JSON format instead of canonical <version>:<hex>', () => {
      const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(() =>
        validateEnv({
          ...baseValidConfig,
          WEBHOOK_SECRET_ENCRYPTION_KEYS: `{"v1":"${hexKey}"}`,
        }),
      ).toThrow(/JSON format is not supported/);
    });

    it('fails closed when key version is non-numeric string', () => {
      const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(() =>
        validateEnv({
          ...baseValidConfig,
          WEBHOOK_SECRET_ENCRYPTION_KEYS: `v1:${hexKey}`,
        }),
      ).toThrow(/Key version in keyring must be a positive integer >= 1/);
    });

    it('fails closed when key version is 0', () => {
      const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(() =>
        validateEnv({
          ...baseValidConfig,
          WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION: '0',
          WEBHOOK_SECRET_ENCRYPTION_KEYS: `0:${hexKey}`,
        }),
      ).toThrow(/must be a positive integer >= 1/);
    });

    it('fails closed when entry format is missing colon delimiter', () => {
      const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(() =>
        validateEnv({
          ...baseValidConfig,
          WEBHOOK_SECRET_ENCRYPTION_KEYS: `1${hexKey}`,
        }),
      ).toThrow(/Invalid keyring entry format/);
    });

    it('accepts multiple valid versions in canonical format', () => {
      const hex1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const hex2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
      const config = validateEnv({
        ...baseValidConfig,
        WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION: '2',
        WEBHOOK_SECRET_ENCRYPTION_KEYS: `1:${hex1}, 2:${hex2}`,
      });
      expect(config.WEBHOOK_SECRET_ENCRYPTION_CURRENT_KEY_VERSION).toBe(2);
    });
  });

  describe('Database Role Isolation', () => {
    it('fails closed if DB_APP_USER is set to omnistock_migrator', () => {
      expect(() =>
        validateEnv({
          ...baseValidConfig,
          DB_APP_USER: 'omnistock_migrator',
        }),
      ).toThrow(/Security violation: DB_APP_USER cannot be set to prohibited role/);
    });

    it('fails closed if DB_APP_USER is set to omnistock_preauth_auditor', () => {
      expect(() =>
        validateEnv({
          ...baseValidConfig,
          DB_APP_USER: 'omnistock_preauth_auditor',
        }),
      ).toThrow(/Security violation: DB_APP_USER cannot be set to prohibited role/);
    });
  });
});
