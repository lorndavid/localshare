import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { BearerAuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { loadApiConfig } from './common/config';
import { HealthController } from './health/health.controller';
import { OrganizationsController } from './organizations/organizations.controller';
import {
  DNS_TXT_RESOLVER,
  ENCRYPTION_KEY_TOKEN,
  OrganizationsService,
  defaultDnsTxtResolver,
} from './organizations/organizations.service';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
    JwtModule.registerAsync({
      useFactory: () => {
        const cfg = loadApiConfig();
        return {
          secret: cfg.jwtSecret,
          signOptions: { expiresIn: 900 },
        };
      },
    }),
  ],
  controllers: [AuthController, OrganizationsController, HealthController],
  providers: [
    PrismaService,
    AuditService,
    AuthService,
    BearerAuthGuard,
    OrganizationsService,
    {
      provide: DNS_TXT_RESOLVER,
      useValue: defaultDnsTxtResolver,
    },
    {
      provide: ENCRYPTION_KEY_TOKEN,
      useFactory: () => loadApiConfig().providerEncryptionKey,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

