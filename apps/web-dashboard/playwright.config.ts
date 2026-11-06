import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  use: {
    baseURL: 'http://localhost:5180',
    headless: true,
    viewport: { width: 1366, height: 820 },
  },
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      port: 3100,
      reuseExistingServer: true,
      env: {
        NODE_ENV: 'development',
        PORT: '3100',
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://localshare:localshare@localhost:55432/localshare?schema=public',
        JWT_SECRET: 'e2e-playwright-jwt-secret-key-at-least-32-chars',
        PROVIDER_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
        CORS_ORIGINS: 'http://localhost:5180',
      },
    },
    {
      command: 'npx vite --port 5180 --strictPort',
      port: 5180,
      reuseExistingServer: true,
    },
  ],
});

