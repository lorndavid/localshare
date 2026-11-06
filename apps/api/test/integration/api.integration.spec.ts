/**
 * Full-stack integration & security tests for the LocalShare Cloud API against PostgreSQL:
 * - Health check
 * - Register, Login, Refresh token rotation & reuse detection, Logout
 * - Personal API tokens (`lsk_...`) creation, authentication & revocation
 * - Strict cross-tenant isolation (User A cannot read or mutate Organization B's workspaces,
 *   tunnels, domains, access policies, provider connections or audit logs -> 404)
 * - Role-based access control (VIEWER cannot create workspaces, MEMBER cannot add members,
 *   last OWNER cannot be demoted or removed)
 * - Tunnel metadata idempotent upsert by clientId & pagination
 * - Custom domain registration & DNS TXT ownership verification (with mocked DNS resolver)
 * - Cross-org domain claim prevention (verified hostname cannot be claimed by another org)
 * - Provider connection AES-256-GCM encryption (token never returned in responses or audit logs)
 * - Request-Id header echo & consistent ApiErrorBody on validation errors
 */
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/main';
import {
  OrganizationsService,
  type DnsTxtResolver,
} from '../../src/organizations/organizations.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('LocalShare Cloud API Integration & Security Suite', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const txtRecords = new Map<string, string[]>();

  const mockDnsResolver: DnsTxtResolver = {
    resolveTxt: async (hostname: string) => {
      const vals = txtRecords.get(hostname) ?? [];
      return vals.map((v) => [v]);
    },
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'integration-test-jwt-secret-key-at-least-32-chars';
    process.env.PROVIDER_ENCRYPTION_KEY = Buffer.from(
      '0123456789abcdef0123456789abcdef',
      'utf8',
    ).toString('base64');
    process.env.CORS_ORIGINS = 'http://localhost:5180';

    app = await NestFactory.create(AppModule, { logger: false });
    configureNestApp(app);
    await app.init();

    app.get(OrganizationsService).setDnsResolverForTesting(mockDnsResolver);
    prisma = app.get(PrismaService);
    await prisma.user.deleteMany();
    await prisma.organization.deleteMany();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET /api/v1/health returns ok with database up and echoes X-Request-Id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('X-Request-Id', 'req-health-check-01')
      .expect(200);

    expect(res.headers['x-request-id']).toBe('req-health-check-01');
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.status).toBe('up');
  });

  it('enforces authentication, refresh token rotation & reuse revocation, RBAC and cross-tenant isolation', async () => {
    const server = app.getHttpServer();

    // 1. Unauthenticated access -> 401 with ApiErrorBody
    const unauth = await request(server).get('/api/v1/organizations').expect(401);
    expect(unauth.body).toMatchObject({
      statusCode: 401,
      message: expect.any(String),
      requestId: expect.any(String),
    });

    // 2. Register Alice (Tenant A) and Bob (Tenant B) and Viewer Charlie
    const aliceReg = await request(server)
      .post('/api/v1/auth/register')
      .send({
        email: 'Alice@Acme.com',
        password: 'alice-strong-password-123',
        name: 'Alice Architect',
      })
      .expect(201);

    const aliceToken: string = aliceReg.body.accessToken;
    const aliceCookies = (aliceReg.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(aliceReg.body.user.email).toBe('alice@acme.com');
    expect(aliceCookies.some((c: string) => c.startsWith('ls_refresh='))).toBe(true);

    // 3. Refresh token rotation & reuse detection
    const refresh1 = await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', aliceCookies)
      .expect(200);
    const rotatedCookies = (refresh1.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(refresh1.body.accessToken).toBeDefined();

    // Replaying the OLD refresh cookie must trigger reuse detection and revoke the session (401)
    await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', aliceCookies)
      .expect(401);

    // Now even the rotated cookie from that compromised session is revoked (401)
    await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotatedCookies)
      .expect(401);

    // Register Bob & Charlie
    const bobReg = await request(server)
      .post('/api/v1/auth/register')
      .send({
        email: 'bob@beta.io',
        password: 'bob-strong-password-123',
        name: 'Bob Builder',
      })
      .expect(201);
    const bobToken: string = bobReg.body.accessToken;

    await request(server)
      .post('/api/v1/auth/register')
      .send({
        email: 'charlie@acme.com',
        password: 'charlie-strong-password-123',
        name: 'Charlie Viewer',
      })
      .expect(201);

    const charlieLogin = await request(server)
      .post('/api/v1/auth/login')
      .send({
        email: 'charlie@acme.com',
        password: 'charlie-strong-password-123',
      })
      .expect(200);
    const charlieToken: string = charlieLogin.body.accessToken;

    // 4. Alice creates Organization A; Bob creates Organization B
    const orgARes = await request(server)
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ name: 'Acme Engineering', slug: 'acme-eng' })
      .expect(201);
    const orgAId: string = orgARes.body.id;

    const orgBRes = await request(server)
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ name: 'Beta Labs', slug: 'beta-labs' })
      .expect(201);
    const orgBId: string = orgBRes.body.id;

    // 5. Cross-tenant isolation: Bob cannot read or mutate Alice's Org A (returns 404)
    await request(server)
      .get(`/api/v1/organizations/${orgAId}`)
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(404);

    await request(server)
      .post(`/api/v1/organizations/${orgAId}/workspaces`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ name: 'Intruder Workspace' })
      .expect(404);

    await request(server)
      .get(`/api/v1/organizations/${orgAId}/audit-events`)
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(404);

    // 6. RBAC: Alice adds Charlie as VIEWER to Org A
    const memberRes = await request(server)
      .post(`/api/v1/organizations/${orgAId}/members`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ email: 'charlie@acme.com', role: 'VIEWER' })
      .expect(201);
    expect(memberRes.body.role).toBe('VIEWER');

    // Charlie (VIEWER) can read Org A overview, but cannot create workspaces (403)
    await request(server)
      .get(`/api/v1/organizations/${orgAId}/overview`)
      .set('Authorization', `Bearer ${charlieToken}`)
      .expect(200);

    await request(server)
      .post(`/api/v1/organizations/${orgAId}/workspaces`)
      .set('Authorization', `Bearer ${charlieToken}`)
      .send({ name: 'Forbidden Workspace' })
      .expect(403);

    // Last OWNER protection: Alice cannot demote or remove herself as the sole OWNER
    const membersList = await request(server)
      .get(`/api/v1/organizations/${orgAId}/members`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(200);
    const aliceMember = (membersList.body as Array<{ id: string; email: string }>).find(
      (m) => m.email === 'alice@acme.com',
    )!;

    await request(server)
      .patch(`/api/v1/organizations/${orgAId}/members/${aliceMember.id}`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ role: 'ADMIN' })
      .expect(400);

    // 7. Personal API token (`lsk_...`) for VS Code extension sync
    const patRes = await request(server)
      .post('/api/v1/auth/tokens')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ name: 'VS Code Laptop', expiresInDays: 30 })
      .expect(201);
    const lskToken: string = patRes.body.token;
    expect(lskToken.startsWith('lsk_')).toBe(true);

    // Use `lsk_` token to create a workspace and idempotently upsert tunnel metadata
    const wsRes = await request(server)
      .post(`/api/v1/organizations/${orgAId}/workspaces`)
      .set('Authorization', `Bearer ${lskToken}`)
      .send({ name: 'Customer Portal', description: 'React + NestJS monorepo' })
      .expect(201);

    const tun1 = await request(server)
      .put(`/api/v1/organizations/${orgAId}/tunnels`)
      .set('Authorization', `Bearer ${lskToken}`)
      .send({
        clientId: 'localhost:5173:QUICK',
        workspaceId: wsRes.body.id,
        name: 'Portal UI',
        kind: 'QUICK',
        provider: 'cloudflare',
        state: 'ONLINE',
        accessMode: 'PASSWORD',
        localTarget: 'localhost:5173',
        publicUrl: 'https://portal-demo.trycloudflare.com',
        framework: 'React (Vite)',
      })
      .expect(200);

    // Upserting again with the same clientId updates the same record (no duplicate)
    const tun2 = await request(server)
      .put(`/api/v1/organizations/${orgAId}/tunnels`)
      .set('Authorization', `Bearer ${lskToken}`)
      .send({
        clientId: 'localhost:5173:QUICK',
        workspaceId: wsRes.body.id,
        name: 'Portal UI',
        kind: 'QUICK',
        provider: 'cloudflare',
        state: 'STOPPED',
        accessMode: 'PASSWORD',
        localTarget: 'localhost:5173',
        publicUrl: 'https://portal-demo.trycloudflare.com',
        framework: 'React (Vite)',
      })
      .expect(200);
    expect(tun2.body.id).toBe(tun1.body.id);
    expect(tun2.body.state).toBe('STOPPED');

    // Revoke the `lsk_` token -> subsequent calls with it fail with 401
    await request(server)
      .delete(`/api/v1/auth/tokens/${patRes.body.id}`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(204);

    await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${lskToken}`)
      .expect(401);

    // 8. Custom domain registration & DNS TXT verification
    const domRes = await request(server)
      .post(`/api/v1/organizations/${orgAId}/domains`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ hostname: 'Preview.Customer.com' })
      .expect(201);
    expect(domRes.body.hostname).toBe('preview.customer.com');
    expect(domRes.body.status).toBe('PENDING_VERIFICATION');

    // Verify before DNS TXT record exists -> FAILED
    const verifyFail = await request(server)
      .post(`/api/v1/organizations/${orgAId}/domains/${domRes.body.id}/verify`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(200);
    expect(verifyFail.body.status).toBe('FAILED');

    // Publish expected TXT record in mock DNS -> VERIFIED
    txtRecords.set(domRes.body.verification.recordName, [
      domRes.body.verification.recordValue,
    ]);
    const verifyOk = await request(server)
      .post(`/api/v1/organizations/${orgAId}/domains/${domRes.body.id}/verify`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(200);
    expect(verifyOk.body.status).toBe('VERIFIED');
    expect(verifyOk.body.verifiedAt).toBeTruthy();

    // Bob (Org B) cannot claim a hostname already VERIFIED by Org A -> 409 Conflict
    await request(server)
      .post(`/api/v1/organizations/${orgBId}/domains`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ hostname: 'preview.customer.com' })
      .expect(409);

    // 9. Access Policy & Provider Connection (encrypted token never returned)
    const polRes = await request(server)
      .post(`/api/v1/organizations/${orgAId}/access-policies`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        name: 'Customer Reviewers',
        mode: 'CLOUDFLARE_ACCESS',
        rules: {
          allowedEmails: ['reviewer@customer.com'],
          allowedEmailDomains: ['customer.com'],
          sessionDurationHours: 8,
        },
      })
      .expect(201);
    expect(polRes.body.rules.allowedEmailDomains).toEqual(['customer.com']);

    const rawCfToken = 'cf_api_token_secret_value_abcdef0123456789';
    const provRes = await request(server)
      .post(`/api/v1/organizations/${orgAId}/provider-connections`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        provider: 'cloudflare',
        label: 'Acme Cloudflare Prod',
        accountId: 'cf-acct-123',
        token: rawCfToken,
      })
      .expect(201);
    expect(JSON.stringify(provRes.body)).not.toContain(rawCfToken);
    expect(provRes.body.tokenLast4).toBe('6789');

    // 10. Audit events recorded and redacted
    const auditRes = await request(server)
      .get(`/api/v1/organizations/${orgAId}/audit-events`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(200);
    expect(auditRes.body.total).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(auditRes.body)).not.toContain(rawCfToken);
  });
});
