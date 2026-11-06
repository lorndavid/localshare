import { loadApiConfig } from '../../src/common/config';
import {
  decryptSecret,
  encryptSecret,
  generatePersonalApiToken,
  generateRefreshToken,
  sha256Hex,
} from '../../src/common/crypto';
import { roleAtLeast } from '@localshare/shared-types';

describe('API Unit Tests: Crypto, Config & Role Hierarchy', () => {
  const key = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

  it('encrypts and decrypts provider tokens with AES-256-GCM and detects tampering', () => {
    const secret = 'cf_token_super_secret_value_1234567890';
    const ciphertext = encryptSecret(secret, key);
    expect(ciphertext).not.toContain(secret);
    expect(decryptSecret(ciphertext, key)).toBe(secret);

    const parts = ciphertext.split('.');
    parts[2] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });

  it('generates lsk_ API tokens and refresh tokens with SHA-256 hashes', () => {
    const apiTok = generatePersonalApiToken();
    expect(apiTok.plaintext.startsWith('lsk_')).toBe(true);
    expect(apiTok.prefix).toBe(apiTok.plaintext.slice(0, 12));
    expect(apiTok.tokenHash).toBe(sha256Hex(apiTok.plaintext));

    const refresh = generateRefreshToken();
    expect(refresh.hash).toBe(sha256Hex(refresh.raw));
  });

  it('validates environment configuration strictly', () => {
    expect(() =>
      loadApiConfig({
        DATABASE_URL: 'postgresql://localhost:5432/db',
        JWT_SECRET: 'short',
        PROVIDER_ENCRYPTION_KEY: key.toString('base64'),
      }),
    ).toThrow(/JWT_SECRET/);

    const valid = loadApiConfig({
      DATABASE_URL: 'postgresql://localhost:5432/db',
      JWT_SECRET: 'a'.repeat(36),
      PROVIDER_ENCRYPTION_KEY: key.toString('base64'),
      CORS_ORIGINS: 'http://localhost:5180, https://app.example.com',
    });
    expect(valid.corsOrigins).toEqual(['http://localhost:5180', 'https://app.example.com']);
  });

  it('enforces role hierarchy OWNER > ADMIN > MEMBER > VIEWER', () => {
    expect(roleAtLeast('OWNER', 'ADMIN')).toBe(true);
    expect(roleAtLeast('ADMIN', 'OWNER')).toBe(false);
    expect(roleAtLeast('MEMBER', 'MEMBER')).toBe(true);
    expect(roleAtLeast('VIEWER', 'MEMBER')).toBe(false);
  });
});

