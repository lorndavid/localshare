/**
 * Environment configuration loader and validator for the LocalShare Cloud API.
 */

export interface ApiEnvConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  providerEncryptionKey: Buffer;
  corsOrigins: string[];
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiEnvConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as ApiEnvConfig['nodeEnv'];
  const port = Number(env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port (1-65535).');
  }

  const databaseUrl = (env.DATABASE_URL ?? '').trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required.');
  }

  const jwtSecret = (env.JWT_SECRET ?? '').trim();
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long.');
  }

  const rawKey = (env.PROVIDER_ENCRYPTION_KEY ?? '').trim();
  let keyBuf: Buffer;
  try {
    keyBuf = Buffer.from(rawKey, 'base64');
  } catch {
    throw new Error('PROVIDER_ENCRYPTION_KEY must be base64-encoded 32 bytes.');
  }
  if (keyBuf.length !== 32) {
    throw new Error('PROVIDER_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM.');
  }

  const corsOrigins = (env.CORS_ORIGINS ?? 'http://localhost:5180')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    nodeEnv,
    port,
    databaseUrl,
    jwtSecret,
    providerEncryptionKey: keyBuf,
    corsOrigins,
  };
}

