import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Request, Response } from 'express';
import type { AuthResponse, UserDto } from '@localshare/shared-types';
import { type AuthenticatedRequest, BearerAuthGuard } from './auth.guard';
import {
  AuthService,
  type ApiTokenItemDto,
  type CreatedApiTokenDto,
} from './auth.service';

export const REFRESH_COOKIE_NAME = 'ls_refresh';
const REFRESH_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

export class RegisterDto {
  @IsString()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}

export class LoginDto {
  @IsString()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}

export class CreateApiTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/v1/auth',
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/v1/auth',
  });
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a new user account' })
  async register(
    @Body() body: RegisterDto,
    @Req() req: Request & { requestId?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const { auth, refreshToken } = await this.authService.register(body, {
      ip: req.ip,
      userAgent: req.header('user-agent'),
      requestId: req.requestId,
    });
    setRefreshCookie(res, refreshToken);
    return auth;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Authenticate with email and password' })
  async login(
    @Body() body: LoginDto,
    @Req() req: Request & { requestId?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const { auth, refreshToken } = await this.authService.login(body, {
      ip: req.ip,
      userAgent: req.header('user-agent'),
      requestId: req.requestId,
    });
    setRefreshCookie(res, refreshToken);
    return auth;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate refresh token and issue a new access token' })
  async refresh(
    @Req() req: Request & { cookies?: Record<string, string>; requestId?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const raw = req.cookies?.[REFRESH_COOKIE_NAME];
    const { auth, refreshToken } = await this.authService.refreshSession(raw, {
      ip: req.ip,
      userAgent: req.header('user-agent'),
      requestId: req.requestId,
    });
    setRefreshCookie(res, refreshToken);
    return auth;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke refresh session and clear cookie' })
  async logout(
    @Req() req: Request & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const raw = req.cookies?.[REFRESH_COOKIE_NAME];
    await this.authService.logout(raw);
    clearRefreshCookie(res);
  }

  @Get('me')
  @UseGuards(BearerAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the currently authenticated user profile' })
  async me(@Req() req: AuthenticatedRequest): Promise<UserDto> {
    return this.authService.getUserById(req.user.userId);
  }

  @Get('tokens')
  @UseGuards(BearerAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active personal API tokens for the VS Code extension' })
  async listTokens(@Req() req: AuthenticatedRequest): Promise<ApiTokenItemDto[]> {
    return this.authService.listApiTokens(req.user.userId);
  }

  @Post('tokens')
  @UseGuards(BearerAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a personal API token (plaintext returned once)' })
  async createToken(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateApiTokenDto,
  ): Promise<CreatedApiTokenDto> {
    return this.authService.createApiToken(req.user.userId, body, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Delete('tokens/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(BearerAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke a personal API token' })
  async revokeToken(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.authService.revokeApiToken(req.user.userId, id, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }
}

