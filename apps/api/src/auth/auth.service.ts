/**
 * Authentication service:
 * - Argon2id password hashing
 * - Short-lived JWT access tokens (15m)
 * - Rotating refresh-token sessions with reuse detection (Session + SessionRotatedToken)
 * - Personal API tokens (`lsk_...`) for the VS Code extension (only SHA-256 stored)
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { AuthResponse, UserDto } from '@localshare/shared-types';
import { validateEmail, validateLabel } from '@localshare/validation';
import { AuditService } from '../audit/audit.service';
import {
  generatePersonalApiToken,
  generateRefreshToken,
  sha256Hex,
} from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';

export const ACCESS_TOKEN_TTL_SECONDS = 900; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 14 * 24 * 3600 * 1000; // 14 days

export interface AuthenticatedPrincipal {
  userId: string;
  email: string;
  name: string;
  authType: 'jwt' | 'api_token';
}

export interface ApiTokenItemDto {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface CreatedApiTokenDto extends ApiTokenItemDto {
  token: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  toUserDto(u: { id: string; email: string; name: string; createdAt: Date }): UserDto {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt.toISOString(),
    };
  }

  async register(
    input: { email: string; password: string; name: string },
    ctx: { ip?: string; userAgent?: string; requestId?: string } = {},
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const emailRes = validateEmail(input.email);
    if (!emailRes.ok) throw new BadRequestException(emailRes.error);
    const nameRes = validateLabel(input.name, 'Name', 100);
    if (!nameRes.ok) throw new BadRequestException(nameRes.error);
    if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 128) {
      throw new BadRequestException('Password must be between 10 and 128 characters.');
    }

    const existing = await this.prisma.user.findUnique({ where: { email: emailRes.value } });
    if (existing) {
      throw new ConflictException('An account with this email address already exists.');
    }

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const user = await this.prisma.user.create({
      data: {
        email: emailRes.value,
        name: nameRes.value,
        passwordHash,
      },
    });

    await this.audit.record({
      actorUserId: user.id,
      action: 'auth.register',
      targetType: 'user',
      targetId: user.id,
      metadata: { email: user.email },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });

    return this.issueSession(user, ctx);
  }

  async login(
    input: { email: string; password: string },
    ctx: { ip?: string; userAgent?: string; requestId?: string } = {},
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const emailRes = validateEmail(input.email);
    if (!emailRes.ok) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    const user = await this.prisma.user.findUnique({ where: { email: emailRes.value } });
    if (!user) {
      await this.audit.record({
        action: 'auth.login.failed',
        metadata: { email: emailRes.value },
        ipAddress: ctx.ip ?? null,
        requestId: ctx.requestId ?? null,
      });
      throw new UnauthorizedException('Invalid email or password.');
    }

    const ok = await argon2.verify(user.passwordHash, input.password ?? '').catch(() => false);
    if (!ok) {
      await this.audit.record({
        actorUserId: user.id,
        action: 'auth.login.failed',
        targetType: 'user',
        targetId: user.id,
        metadata: { email: user.email },
        ipAddress: ctx.ip ?? null,
        requestId: ctx.requestId ?? null,
      });
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.audit.record({
      actorUserId: user.id,
      action: 'auth.login.succeeded',
      targetType: 'user',
      targetId: user.id,
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });

    return this.issueSession(user, ctx);
  }

  /** Rotate a refresh token; if a previously rotated token is presented, revoke the entire session. */
  async refreshSession(
    rawRefreshToken: string | undefined,
    ctx: { ip?: string; userAgent?: string; requestId?: string } = {},
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    if (!rawRefreshToken) {
      throw new UnauthorizedException('Missing refresh token.');
    }
    const hash = sha256Hex(rawRefreshToken);

    // Check reuse of an already rotated refresh token
    const reused = await this.prisma.sessionRotatedToken.findUnique({
      where: { tokenHash: hash },
      include: { session: true },
    });
    if (reused) {
      await this.prisma.session.update({
        where: { id: reused.sessionId },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({
        actorUserId: reused.session.userId,
        action: 'auth.refresh.reuse_detected',
        targetType: 'session',
        targetId: reused.sessionId,
        ipAddress: ctx.ip ?? null,
        requestId: ctx.requestId ?? null,
      });
      throw new UnauthorizedException('Refresh token reuse detected; session revoked.');
    }

    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hash },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token is invalid or expired.');
    }

    const next = generateRefreshToken();
    await this.prisma.$transaction([
      this.prisma.sessionRotatedToken.create({
        data: {
          sessionId: session.id,
          tokenHash: session.tokenHash,
        },
      }),
      this.prisma.session.update({
        where: { id: session.id },
        data: {
          tokenHash: next.hash,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
      }),
    ]);

    return {
      auth: this.buildAuthResponse(session.user),
      refreshToken: next.raw,
    };
  }

  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) return;
    const hash = sha256Hex(rawRefreshToken);
    await this.prisma.session.updateMany({
      where: { tokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async getUserById(userId: string): Promise<UserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found.');
    return this.toUserDto(user);
  }

  async listApiTokens(userId: string): Promise<ApiTokenItemDto[]> {
    const tokens = await this.prisma.apiToken.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return tokens.map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
      expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
    }));
  }

  async createApiToken(
    userId: string,
    input: { name: string; expiresInDays?: number },
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<CreatedApiTokenDto> {
    const nameRes = validateLabel(input.name, 'Token name', 64);
    if (!nameRes.ok) throw new BadRequestException(nameRes.error);
    const gen = generatePersonalApiToken();
    const expiresAt =
      input.expiresInDays && input.expiresInDays > 0
        ? new Date(Date.now() + input.expiresInDays * 86400 * 1000)
        : null;

    const created = await this.prisma.apiToken.create({
      data: {
        userId,
        name: nameRes.value,
        prefix: gen.prefix,
        tokenHash: gen.tokenHash,
        expiresAt,
      },
    });

    await this.audit.record({
      actorUserId: userId,
      action: 'auth.api_token.created',
      targetType: 'api_token',
      targetId: created.id,
      metadata: { name: created.name, prefix: created.prefix },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
      knownSecrets: [gen.plaintext],
    });

    return {
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      createdAt: created.createdAt.toISOString(),
      lastUsedAt: null,
      expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
      token: gen.plaintext,
    };
  }

  async revokeApiToken(
    userId: string,
    tokenId: string,
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<void> {
    await this.prisma.apiToken.updateMany({
      where: { id: tokenId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'auth.api_token.revoked',
      targetType: 'api_token',
      targetId: tokenId,
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });
  }

  /** Verify either a Bearer JWT access token or an `lsk_` Personal API Token. */
  async authenticateBearer(bearerToken: string): Promise<AuthenticatedPrincipal> {
    if (bearerToken.startsWith('lsk_')) {
      const hash = sha256Hex(bearerToken);
      const tok = await this.prisma.apiToken.findUnique({
        where: { tokenHash: hash },
        include: { user: true },
      });
      if (!tok || tok.revokedAt || (tok.expiresAt && tok.expiresAt.getTime() < Date.now())) {
        throw new UnauthorizedException('API token is invalid, expired, or revoked.');
      }
      await this.prisma.apiToken.update({
        where: { id: tok.id },
        data: { lastUsedAt: new Date() },
      });
      return {
        userId: tok.user.id,
        email: tok.user.email,
        name: tok.user.name,
        authType: 'api_token',
      };
    }

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string; name: string }>(
        bearerToken,
      );
      return {
        userId: payload.sub,
        email: payload.email,
        name: payload.name,
        authType: 'jwt',
      };
    } catch {
      throw new UnauthorizedException('Access token is invalid or expired.');
    }
  }

  private async issueSession(
    user: { id: string; email: string; name: string; createdAt: Date },
    ctx: { ip?: string; userAgent?: string },
  ): Promise<{ auth: AuthResponse; refreshToken: string }> {
    const refresh = generateRefreshToken();
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: refresh.hash,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        ip: ctx.ip?.slice(0, 64) ?? null,
        userAgent: ctx.userAgent?.slice(0, 512) ?? null,
      },
    });
    return {
      auth: this.buildAuthResponse(user),
      refreshToken: refresh.raw,
    };
  }

  private buildAuthResponse(user: {
    id: string;
    email: string;
    name: string;
    createdAt: Date;
  }): AuthResponse {
    const accessToken = this.jwt.sign(
      { sub: user.id, email: user.email, name: user.name },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );
    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: this.toUserDto(user),
    };
  }
}

