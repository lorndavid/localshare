import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type AuthenticatedPrincipal } from './auth.service';

export type AuthenticatedRequest = Request & {
  user: AuthenticatedPrincipal;
  requestId?: string;
};

@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.header('authorization') ?? '';
    if (!/^bearer\s+\S+/i.test(header)) {
      throw new UnauthorizedException('Bearer authentication token is required.');
    }
    const token = header.replace(/^bearer\s+/i, '').trim();
    req.user = await this.auth.authenticateBearer(token);
    return true;
  }
}

