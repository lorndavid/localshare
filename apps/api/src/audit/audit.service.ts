import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { redactSecrets } from '@localshare/validation';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordAuditParams {
  organizationId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  requestId?: string | null;
  knownSecrets?: readonly string[];
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(params: RecordAuditParams): Promise<void> {
    const rawMeta = params.metadata ?? {};
    const sanitized = JSON.parse(
      redactSecrets(JSON.stringify(rawMeta), params.knownSecrets ?? []),
    ) as Prisma.InputJsonValue;

    await this.prisma.auditEvent.create({
      data: {
        organizationId: params.organizationId ?? null,
        actorUserId: params.actorUserId ?? null,
        action: params.action,
        targetType: params.targetType ?? null,
        targetId: params.targetId ?? null,
        metadata: sanitized,
        ipAddress: params.ipAddress ?? null,
        requestId: params.requestId ?? null,
      },
    });
  }
}

