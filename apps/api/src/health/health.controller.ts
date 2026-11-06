import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { HealthDto } from '@localshare/shared-types';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Health and database readiness probe' })
  async check(): Promise<HealthDto> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ok',
        version: '1.0.0',
        uptimeSeconds: Math.floor(process.uptime()),
        checks: {
          database: {
            status: 'up',
            latencyMs: Date.now() - start,
          },
        },
      };
    } catch (err) {
      return {
        status: 'degraded',
        version: '1.0.0',
        uptimeSeconds: Math.floor(process.uptime()),
        checks: {
          database: {
            status: 'down',
            error: err instanceof Error ? err.message : String(err),
          },
        },
      };
    }
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe' })
  async ready(): Promise<HealthDto> {
    return this.check();
  }
}

