/**
 * Cryptographic helpers for token hashing, personal API token generation and AES-256-GCM
 * encryption of provider credentials at rest.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(36).toString('base64url');
  return { raw, hash: sha256Hex(raw) };
}

export function generatePersonalApiToken(): {
  plaintext: string;
  prefix: string;
  tokenHash: string;
} {
  const body = randomBytes(28).toString('base64url');
  const plaintext = `lsk_${body}`;
  const prefix = plaintext.slice(0, 12);
  return {
    plaintext,
    prefix,
    tokenHash: sha256Hex(plaintext),
  };
}

/** Encrypt plaintext with AES-256-GCM into `base64(iv).base64(authTag).base64(ciphertext)`. */
export function encryptSecret(plaintext: string, key32: Buffer): string {
  if (key32.length !== 32) {
    throw new Error('AES-256-GCM requires a 32-byte key.');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key32, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

/** Decrypt an AES-256-GCM payload produced by `encryptSecret`. */
export function decryptSecret(serialized: string, key32: Buffer): string {
  if (key32.length !== 32) {
    throw new Error('AES-256-GCM requires a 32-byte key.');
  }
  const parts = serialized.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload.');
  }
  const iv = Buffer.from(parts[0]!, 'base64');
  const tag = Buffer.from(parts[1]!, 'base64');
  const data = Buffer.from(parts[2]!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key32, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

