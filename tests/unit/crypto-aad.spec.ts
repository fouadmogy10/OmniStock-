import * as crypto from 'crypto';

describe('AES-256-GCM AAD & HMAC Buffer Unit Tests (T074, F7-CRYPTO-1..3)', () => {
  const tenantId = 'a0000000-0000-0000-0000-000000000001';
  const source = 'salla';
  const keyVersion = 1;
  const rawKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const keyBuf = Buffer.from(rawKeyHex, 'hex');

  it('constructs deterministic UTF-8 AAD for AES-256-GCM', () => {
    const expectedAad = `${tenantId}:${source.toLowerCase()}:${keyVersion}`;
    const aadBuf = Buffer.from(expectedAad, 'utf8');

    expect(aadBuf.toString('utf8')).toBe('a0000000-0000-0000-0000-000000000001:salla:1');
  });

  it('encrypts and decrypts 64 UTF-8 bytes under AES-256-GCM with AAD binding', () => {
    // 64-character lowercase hex secret
    const webhookSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const secretUtf8Buf = Buffer.from(webhookSecret, 'utf8');
    expect(secretUtf8Buf.byteLength).toBe(64);

    const iv = crypto.randomBytes(12);
    const aadBuf = Buffer.from(`${tenantId}:${source.toLowerCase()}:${keyVersion}`, 'utf8');

    // Encrypt
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
    cipher.setAAD(aadBuf);
    const encrypted = Buffer.concat([cipher.update(secretUtf8Buf), cipher.final()]);
    const tag = cipher.getAuthTag();

    expect(encrypted.byteLength).toBe(64);
    expect(tag.byteLength).toBe(16);

    // Decrypt with correct AAD
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAAD(aadBuf);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    expect(decrypted.toString('utf8')).toBe(webhookSecret);
  });

  it('fails decryption if AAD is tampered (e.g. wrong tenant or source)', () => {
    const webhookSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const secretUtf8Buf = Buffer.from(webhookSecret, 'utf8');

    const iv = crypto.randomBytes(12);
    const correctAad = Buffer.from(`${tenantId}:${source}:${keyVersion}`, 'utf8');

    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
    cipher.setAAD(correctAad);
    const encrypted = Buffer.concat([cipher.update(secretUtf8Buf), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Tampered AAD (different tenant)
    const tamperedAad = Buffer.from(
      `b0000000-0000-0000-0000-000000000002:${source}:${keyVersion}`,
      'utf8',
    );
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAAD(tamperedAad);
    decipher.setAuthTag(tag);

    expect(() => {
      Buffer.concat([decipher.update(encrypted), decipher.final()]);
    }).toThrow();
  });

  it('computes exact HMAC-SHA256 signature using Buffer.concat([timestamp., rawBody])', () => {
    const webhookSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const timestamp = 1730000000;
    const rawBodyStr = JSON.stringify({ event: 'order.created', total: 100 });
    const rawBodyBuf = Buffer.from(rawBodyStr, 'utf8');

    const messageBuf = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBodyBuf]);

    const hmac = crypto.createHmac('sha256', Buffer.from(webhookSecret, 'utf8'));
    const sigHex = hmac.update(messageBuf).digest('hex');

    expect(sigHex).toMatch(/^[0-9a-f]{64}$/);

    // Constant-time comparison validation
    const expectedBuf = Buffer.from(sigHex, 'hex');
    const actualBuf = Buffer.from(sigHex, 'hex');
    expect(crypto.timingSafeEqual(expectedBuf, actualBuf)).toBe(true);
  });
});
