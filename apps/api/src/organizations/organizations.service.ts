/**
 * Organization-scoped services with strict tenant isolation and RBAC enforcement.
 */
import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  roleAtLeast,
  type AccessMode,
  type AccessPolicyDto,
  type AccessPolicyRules,
  type AuditEventDto,
  type DomainDto,
  type MemberDto,
  type OrgRole,
  type OrganizationDto,
  type OrganizationOverviewDto,
  type Paginated,
  type TunnelDto,
  type UpsertTunnelRequest,
  type WorkspaceDto,
} from '@localshare/shared-types';
import {
  validateDescription,
  validateEmail,
  validateEmailDomain,
  validateHostname,
  validateLabel,
} from '@localshare/validation';
import { AuditService } from '../audit/audit.service';
import { encryptSecret } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';

export const DNS_TXT_RESOLVER = 'DNS_TXT_RESOLVER';
export const ENCRYPTION_KEY_TOKEN = 'ENCRYPTION_KEY_TOKEN';

export interface DnsTxtResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export const defaultDnsTxtResolver: DnsTxtResolver = (() => {
  const resolver = new Resolver();
  return {
    resolveTxt: (h: string) => resolver.resolveTxt(h).catch(() => []),
  };
})();

export interface ProviderConnectionDto {
  id: string;
  provider: string;
  label: string;
  accountId: string | null;
  tokenLast4: string;
  createdAt: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(DNS_TXT_RESOLVER) private dnsResolver: DnsTxtResolver,
    @Inject(ENCRYPTION_KEY_TOKEN) private readonly encryptionKey: Buffer,
  ) {}

  setDnsResolverForTesting(resolver: DnsTxtResolver): void {
    this.dnsResolver = resolver;
  }

  /**
   * Verify that `userId` is a member of an active (non-deleted) organization and has at least
   * `minRole`. Returns 404 when the user is not a member to prevent cross-tenant enumeration.
   */
  async requireMembership(
    userId: string,
    orgId: string,
    minRole: OrgRole = 'VIEWER',
  ): Promise<{ organization: { id: string; name: string; slug: string; createdAt: Date }; role: OrgRole }> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: orgId,
          userId,
        },
      },
      include: { organization: true },
    });

    if (!membership || membership.organization.deletedAt) {
      throw new NotFoundException('Organization not found.');
    }

    const role = membership.role as OrgRole;
    if (!roleAtLeast(role, minRole)) {
      throw new ForbiddenException(`Requires ${minRole} role or higher in this organization.`);
    }

    return {
      organization: membership.organization,
      role,
    };
  }

  // ---------------------------------------------------------------------------
  // Organizations
  // ---------------------------------------------------------------------------

  async listOrganizations(userId: string): Promise<OrganizationDto[]> {
    const memberships = await this.prisma.organizationMember.findMany({
      where: {
        userId,
        organization: { deletedAt: null },
      },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role as OrgRole,
      createdAt: m.organization.createdAt.toISOString(),
    }));
  }

  async createOrganization(
    userId: string,
    input: { name: string; slug?: string },
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<OrganizationDto> {
    const nameRes = validateLabel(input.name, 'Organization name', 64);
    if (!nameRes.ok) throw new BadRequestException(nameRes.error);

    let slug = input.slug ? slugify(input.slug) : slugify(nameRes.value);
    if (slug.length < 2) {
      slug = `org-${randomBytes(3).toString('hex')}`;
    }

    const existing = await this.prisma.organization.findUnique({ where: { slug } });
    if (existing) {
      if (input.slug) {
        throw new ConflictException(`Organization slug "${slug}" is already taken.`);
      }
      slug = `${slug}-${randomBytes(3).toString('hex')}`;
    }

    const org = await this.prisma.organization.create({
      data: {
        name: nameRes.value,
        slug,
        members: {
          create: {
            userId,
            role: 'OWNER',
          },
        },
      },
    });

    await this.audit.record({
      organizationId: org.id,
      actorUserId: userId,
      action: 'organization.created',
      targetType: 'organization',
      targetId: org.id,
      metadata: { name: org.name, slug: org.slug },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: 'OWNER',
      createdAt: org.createdAt.toISOString(),
    };
  }

  async getOrganization(userId: string, orgId: string): Promise<OrganizationDto> {
    const { organization, role } = await this.requireMembership(userId, orgId, 'VIEWER');
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role,
      createdAt: organization.createdAt.toISOString(),
    };
  }

  async updateOrganization(
    userId: string,
    orgId: string,
    input: { name: string },
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<OrganizationDto> {
    const { role } = await this.requireMembership(userId, orgId, 'ADMIN');
    const nameRes = validateLabel(input.name, 'Organization name', 64);
    if (!nameRes.ok) throw new BadRequestException(nameRes.error);

    const updated = await this.prisma.organization.update({
      where: { id: orgId },
      data: { name: nameRes.value },
    });

    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'organization.updated',
      targetType: 'organization',
      targetId: orgId,
      metadata: { name: updated.name },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      role,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  async deleteOrganization(
    userId: string,
    orgId: string,
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<void> {
    await this.requireMembership(userId, orgId, 'OWNER');
    await this.prisma.organization.update({
      where: { id: orgId },
      data: { deletedAt: new Date() },
    });
    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'organization.deleted',
      targetType: 'organization',
      targetId: orgId,
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });
  }

  async getOverview(userId: string, orgId: string): Promise<OrganizationOverviewDto> {
    await this.requireMembership(userId, orgId, 'VIEWER');
    const [
      workspaces,
      activeTunnels,
      totalTunnels,
      verifiedDomains,
      pendingDomains,
      members,
      recentEvents,
    ] = await Promise.all([
      this.prisma.workspace.count({ where: { organizationId: orgId } }),
      this.prisma.tunnel.count({ where: { organizationId: orgId, state: 'ONLINE' } }),
      this.prisma.tunnel.count({ where: { organizationId: orgId } }),
      this.prisma.domain.count({ where: { organizationId: orgId, status: 'VERIFIED' } }),
      this.prisma.domain.count({ where: { organizationId: orgId, status: 'PENDING_VERIFICATION' } }),
      this.prisma.organizationMember.count({ where: { organizationId: orgId } }),
      this.prisma.auditEvent.findMany({
        where: { organizationId: orgId },
        include: { actor: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    return {
      workspaces,
      activeTunnels,
      totalTunnels,
      verifiedDomains,
      pendingDomains,
      members,
      recentEvents: recentEvents.map((e) => this.toAuditEventDto(e)),
    };
  }

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------

  async listMembers(userId: string, orgId: string): Promise<MemberDto[]> {
    await this.requireMembership(userId, orgId, 'VIEWER');
    const list = await this.prisma.organizationMember.findMany({
      where: { organizationId: orgId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return list.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role as OrgRole,
      createdAt: m.createdAt.toISOString(),
    }));
  }

  async addMember(
    userId: string,
    orgId: string,
    input: { email: string; role: OrgRole },
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<MemberDto> {
    const { role: callerRole } = await this.requireMembership(userId, orgId, 'ADMIN');
    if (input.role === 'OWNER' && callerRole !== 'OWNER') {
      throw new ForbiddenException('Only an OWNER can grant the OWNER role.');
    }

    const emailRes = validateEmail(input.email);
    if (!emailRes.ok) throw new BadRequestException(emailRes.error);

    const targetUser = await this.prisma.user.findUnique({ where: { email: emailRes.value } });
    if (!targetUser) {
      throw new NotFoundException(`No registered LocalShare user found with email ${emailRes.value}.`);
    }

    const existing = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: orgId,
          userId: targetUser.id,
        },
      },
    });
    if (existing) {
      throw new ConflictException('User is already a member of this organization.');
    }

    const created = await this.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: targetUser.id,
        role: input.role,
      },
      include: { user: true },
    });

    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'member.added',
      targetType: 'member',
      targetId: created.id,
      metadata: { email: targetUser.email, role: input.role },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });

    return {
      id: created.id,
      userId: created.userId,
      email: created.user.email,
      name: created.user.name,
      role: created.role as OrgRole,
      createdAt: created.createdAt.toISOString(),
    };
  }

  async updateMemberRole(
    userId: string,
    orgId: string,
    memberId: string,
    input: { role: OrgRole },
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<MemberDto> {
    const { role: callerRole } = await this.requireMembership(userId, orgId, 'ADMIN');
    if (input.role === 'OWNER' && callerRole !== 'OWNER') {
      throw new ForbiddenException('Only an OWNER can grant the OWNER role.');
    }

    const target = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId: orgId },
      include: { user: true },
    });
    if (!target) throw new NotFoundException('Member not found.');

    if (target.role === 'OWNER' && input.role !== 'OWNER') {
      if (callerRole !== 'OWNER') {
        throw new ForbiddenException('Only an OWNER can demote another OWNER.');
      }
      const ownerCount = await this.prisma.organizationMember.count({
        where: { organizationId: orgId, role: 'OWNER' },
      });
      if (ownerCount <= 1) {
        throw new BadRequestException('Cannot demote the last OWNER of an organization.');
      }
    }

    const updated = await this.prisma.organizationMember.update({
      where: { id: memberId },
      data: { role: input.role },
      include: { user: true },
    });

    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'member.role_updated',
      targetType: 'member',
      targetId: memberId,
      metadata: { email: updated.user.email, role: input.role },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });

    return {
      id: updated.id,
      userId: updated.userId,
      email: updated.user.email,
      name: updated.user.name,
      role: updated.role as OrgRole,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  async removeMember(
    userId: string,
    orgId: string,
    memberId: string,
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<void> {
    const { role: callerRole } = await this.requireMembership(userId, orgId, 'ADMIN');
    const target = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId: orgId },
      include: { user: true },
    });
    if (!target) throw new NotFoundException('Member not found.');

    if (target.role === 'OWNER') {
      if (callerRole !== 'OWNER') {
        throw new ForbiddenException('Only an OWNER can remove an OWNER.');
      }
      const ownerCount = await this.prisma.organizationMember.count({
        where: { organizationId: orgId, role: 'OWNER' },
      });
      if (ownerCount <= 1) {
        throw new BadRequestException('Cannot remove the last OWNER of an organization.');
      }
    }

    await this.prisma.organizationMember.delete({ where: { id: memberId } });
    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'member.removed',
      targetType: 'member',
      targetId: memberId,
      metadata: { email: target.user.email },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Workspaces
  // ---------------------------------------------------------------------------

  private toWorkspaceDto(w: {
    id: string;
    organizationId: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): WorkspaceDto {
    return {
      id: w.id,
      organizationId: w.organizationId,
      name: w.name,
      description: w.description,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  async listWorkspaces(userId: string, orgId: string): Promise<WorkspaceDto[]> {
    await this.requireMembership(userId, orgId, 'VIEWER');
    const list = await this.prisma.workspace.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    return list.map((w) => this.toWorkspaceDto(w));
  }

  async createWorkspace(
    userId: string,
    orgId: string,
    input: { name: string; description?: string },
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<WorkspaceDto> {
    await this.requireMembership(userId, orgId, 'MEMBER');
    const nameRes = validateLabel(input.name, 'Workspace name', 64);
    if (!nameRes.ok) throw new BadRequestException(nameRes.error);
    const descRes = validateDescription(input.description, 500);
    if (!descRes.ok) throw new BadRequestException(descRes.error);

    const existing = await this.prisma.workspace.findUnique({
      where: { organizationId_name: { organizationId: orgId, name: nameRes.value } },
    });
    if (existing) {
      throw new ConflictException(`Workspace "${nameRes.value}" already exists in this organization.`);
    }

    const created = await this.prisma.workspace.create({
      data: {
        organizationId: orgId,
        name: nameRes.value,
        description: descRes.value || null,
      },
    });

    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'workspace.created',
      targetType: 'workspace',
      targetId: created.id,
      metadata: { name: created.name },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });

    return this.toWorkspaceDto(created);
  }

  async updateWorkspace(
    userId: string,
    orgId: string,
    workspaceId: string,
    input: { name?: string; description?: string },
  ): Promise<WorkspaceDto> {
    await this.requireMembership(userId, orgId, 'MEMBER');
    const existing = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Workspace not found.');

    let name = existing.name;
    if (input.name !== undefined) {
      const r = validateLabel(input.name, 'Workspace name', 64);
      if (!r.ok) throw new BadRequestException(r.error);
      name = r.value;
    }

    let description = existing.description;
    if (input.description !== undefined) {
      const d = validateDescription(input.description, 500);
      if (!d.ok) throw new BadRequestException(d.error);
      description = d.value || null;
    }

    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { name, description },
    });
    return this.toWorkspaceDto(updated);
  }

  async deleteWorkspace(
    userId: string,
    orgId: string,
    workspaceId: string,
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<void> {
    await this.requireMembership(userId, orgId, 'MEMBER');
    const existing = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Workspace not found.');
    await this.prisma.workspace.delete({ where: { id: workspaceId } });
    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'workspace.deleted',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { name: existing.name },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Tunnels (Metadata Only)
  // ---------------------------------------------------------------------------

  private toTunnelDto(t: {
    id: string;
    organizationId: string;
    workspaceId: string | null;
    name: string;
    kind: string;
    provider: string;
    state: string;
    accessMode: string;
    localTarget: string;
    publicUrl: string | null;
    framework: string | null;
    startedAt: Date | null;
    stoppedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): TunnelDto {
    return {
      id: t.id,
      organizationId: t.organizationId,
      workspaceId: t.workspaceId,
      name: t.name,
      kind: t.kind as TunnelDto['kind'],
      provider: t.provider as TunnelDto['provider'],
      state: t.state as TunnelDto['state'],
      accessMode: t.accessMode as TunnelDto['accessMode'],
      localTarget: t.localTarget,
      publicUrl: t.publicUrl,
      framework: t.framework,
      startedAt: t.startedAt ? t.startedAt.toISOString() : null,
      stoppedAt: t.stoppedAt ? t.stoppedAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  async listTunnels(
    userId: string,
    orgId: string,
    query: { page?: number; pageSize?: number; state?: string; workspaceId?: string },
  ): Promise<Paginated<TunnelDto>> {
    await this.requireMembership(userId, orgId, 'VIEWER');
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));

    const where: Prisma.TunnelWhereInput = {
      organizationId: orgId,
      ...(query.state ? { state: query.state as Prisma.EnumTunnelStateFilter['equals'] } : {}),
      ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.tunnel.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tunnel.count({ where }),
    ]);

    return {
      items: items.map((t) => this.toTunnelDto(t)),
      page,
      pageSize,
      total,
    };
  }

  async getTunnel(userId: string, orgId: string, tunnelId: string): Promise<TunnelDto> {
    await this.requireMembership(userId, orgId, 'VIEWER');
    const t = await this.prisma.tunnel.findFirst({
      where: { id: tunnelId, organizationId: orgId },
    });
    if (!t) throw new NotFoundException('Tunnel record not found.');
    return this.toTunnelDto(t);
  }

  async upsertTunnel(
    userId: string,
    orgId: string,
    input: UpsertTunnelRequest,
  ): Promise<TunnelDto> {
    await this.requireMembership(userId, orgId, 'MEMBER');
    const nameRes = validateLabel(input.name, 'Tunnel name', 64);
    if (!nameRes.ok) throw new BadRequestException(nameRes.error);

    if (input.workspaceId) {
      const ws = await this.prisma.workspace.findFirst({
        where: { id: input.workspaceId, organizationId: orgId },
      });
      if (!ws) throw new BadRequestException('Workspace does not belong to this organization.');
    }

    const upserted = await this.prisma.tunnel.upsert({
      where: {
        organizationId_clientId: {
          organizationId: orgId,
          clientId: input.clientId,
        },
      },
      create: {
        organizationId: orgId,
        workspaceId: input.workspaceId ?? null,
        clientId: input.clientId,
        name: nameRes.value,
        kind: input.kind,
        provider: input.provider,
        state: input.state,
        accessMode: input.accessMode,
        localTarget: input.localTarget,
        publicUrl: input.publicUrl ?? null,
        framework: input.framework ?? null,
        startedAt: input.startedAt ? new Date(input.startedAt) : null,
        stoppedAt: input.stoppedAt ? new Date(input.stoppedAt) : null,
      },
      update: {
        workspaceId: input.workspaceId ?? undefined,
        name: nameRes.value,
        state: input.state,
        accessMode: input.accessMode,
        localTarget: input.localTarget,
        publicUrl: input.publicUrl ?? null,
        framework: input.framework ?? null,
        startedAt: input.startedAt ? new Date(input.startedAt) : undefined,
        stoppedAt: input.stoppedAt ? new Date(input.stoppedAt) : null,
      },
    });

    return this.toTunnelDto(upserted);
  }

  async deleteTunnel(userId: string, orgId: string, tunnelId: string): Promise<void> {
    await this.requireMembership(userId, orgId, 'MEMBER');
    const existing = await this.prisma.tunnel.findFirst({
      where: { id: tunnelId, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Tunnel record not found.');
    await this.prisma.tunnel.delete({ where: { id: tunnelId } });
  }

  // ---------------------------------------------------------------------------
  // Custom Domains & DNS TXT Ownership Verification
  // ---------------------------------------------------------------------------

  private toDomainDto(d: {
    id: string;
    organizationId: string;
    hostname: string;
    status: string;
    verifiedAt: Date | null;
    createdAt: Date;
    verification: {
      method: string;
      recordName: string;
      recordValue: string;
      lastCheckedAt: Date | null;
      lastError: string | null;
    } | null;
  }): DomainDto {
    const v = d.verification!;
    return {
      id: d.id,
      organizationId: d.organizationId,
      hostname: d.hostname,
      status: d.status as DomainDto['status'],
      verification: {
        method: 'DNS_TXT',
        recordName: v.recordName,
        recordValue: v.recordValue,
        lastCheckedAt: v.lastCheckedAt ? v.lastCheckedAt.toISOString() : null,
        lastError: v.lastError,
      },
      verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    };
  }

  async listDomains(userId: string, orgId: string): Promise<DomainDto[]> {
    await this.requireMembership(userId, orgId, 'VIEWER');
    const list = await this.prisma.domain.findMany({
      where: { organizationId: orgId },
      include: { verification: true },
      orderBy: { createdAt: 'desc' },
    });
    return list.map((d) => this.toDomainDto(d));
  }

  async createDomain(
    userId: string,
    orgId: string,
    input: { hostname: string },
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<DomainDto> {
    await this.requireMembership(userId, orgId, 'ADMIN');
    const valid = validateHostname(input.hostname);
    if (!valid.ok) throw new BadRequestException(valid.error);
    const hostname = valid.value;

    const alreadyVerifiedElsewhere = await this.prisma.domain.findFirst({
      where: { hostname, status: 'VERIFIED' },
    });
    if (alreadyVerifiedElsewhere && alreadyVerifiedElsewhere.organizationId !== orgId) {
      throw new ConflictException(`Hostname "${hostname}" is already verified by another organization.`);
    }

    const existingInOrg = await this.prisma.domain.findUnique({
      where: { organizationId_hostname: { organizationId: orgId, hostname } },
    });
    if (existingInOrg) {
      throw new ConflictException(`Hostname "${hostname}" is already registered in this organization.`);
    }

    const token = randomBytes(18).toString('hex');
    const created = await this.prisma.domain.create({
      data: {
        organizationId: orgId,
        hostname,
        status: 'PENDING_VERIFICATION',
        verification: {
          create: {
            method: 'DNS_TXT',
            recordName: `_localshare-challenge.${hostname}`,
            recordValue: `localshare-verify=${token}`,
          },
        },
      },
      include: { verification: true },
    });

    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'domain.created',
      targetType: 'domain',
      targetId: created.id,
      metadata: { hostname },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });

    return this.toDomainDto(created);
  }

  async verifyDomain(
    userId: string,
    orgId: string,
    domainId: string,
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<DomainDto> {
    await this.requireMembership(userId, orgId, 'ADMIN');
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, organizationId: orgId },
      include: { verification: true },
    });
    if (!domain || !domain.verification) {
      throw new NotFoundException('Domain not found.');
    }

    const alreadyVerifiedElsewhere = await this.prisma.domain.findFirst({
      where: {
        hostname: domain.hostname,
        status: 'VERIFIED',
        NOT: { organizationId: orgId },
      },
    });
    if (alreadyVerifiedElsewhere) {
      throw new ConflictException(`Hostname "${domain.hostname}" is already claimed by another organization.`);
    }

    const records = await this.dnsResolver.resolveTxt(domain.verification.recordName);
    const flattened = records.map((chunks) => chunks.join('').trim());
    const matched = flattened.includes(domain.verification.recordValue);

    const now = new Date();
    if (matched) {
      const updated = await this.prisma.domain.update({
        where: { id: domain.id },
        data: {
          status: 'VERIFIED',
          verifiedAt: now,
          verification: {
            update: {
              lastCheckedAt: now,
              lastError: null,
              attempts: { increment: 1 },
            },
          },
        },
        include: { verification: true },
      });

      await this.audit.record({
        organizationId: orgId,
        actorUserId: userId,
        action: 'domain.verified',
        targetType: 'domain',
        targetId: domain.id,
        metadata: { hostname: domain.hostname },
        ipAddress: ctx.ip ?? null,
        requestId: ctx.requestId ?? null,
      });

      return this.toDomainDto(updated);
    }

    const errorMsg =
      flattened.length === 0
        ? `No TXT record found at ${domain.verification.recordName}.`
        : `TXT record at ${domain.verification.recordName} did not match expected value.`;

    const failed = await this.prisma.domain.update({
      where: { id: domain.id },
      data: {
        status: 'FAILED',
        verification: {
          update: {
            lastCheckedAt: now,
            lastError: errorMsg,
            attempts: { increment: 1 },
          },
        },
      },
      include: { verification: true },
    });

    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'domain.verification_failed',
      targetType: 'domain',
      targetId: domain.id,
      metadata: { hostname: domain.hostname, error: errorMsg },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });

    return this.toDomainDto(failed);
  }

  async deleteDomain(
    userId: string,
    orgId: string,
    domainId: string,
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<void> {
    await this.requireMembership(userId, orgId, 'ADMIN');
    const existing = await this.prisma.domain.findFirst({
      where: { id: domainId, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Domain not found.');
    await this.prisma.domain.delete({ where: { id: domainId } });
    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'domain.deleted',
      targetType: 'domain',
      targetId: domainId,
      metadata: { hostname: existing.hostname },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Access Policies
  // ---------------------------------------------------------------------------

  private validateAndNormalizePolicyRules(
    mode: AccessMode,
    rules: AccessPolicyRules,
  ): AccessPolicyRules {
    const allowedEmails: string[] = [];
    for (const raw of rules.allowedEmails ?? []) {
      const r = validateEmail(raw);
      if (!r.ok) throw new BadRequestException(r.error);
      allowedEmails.push(r.value);
    }

    const allowedEmailDomains: string[] = [];
    for (const raw of rules.allowedEmailDomains ?? []) {
      const r = validateEmailDomain(raw);
      if (!r.ok) throw new BadRequestException(r.error);
      allowedEmailDomains.push(r.value);
    }

    if (mode === 'CLOUDFLARE_ACCESS' && allowedEmails.length === 0 && allowedEmailDomains.length === 0) {
      throw new BadRequestException(
        'CLOUDFLARE_ACCESS mode requires at least one allowed email or email domain.',
      );
    }

    const sessionDurationHours = Math.min(
      168,
      Math.max(1, Math.floor(Number(rules.sessionDurationHours ?? 12))),
    );

    return {
      allowedEmails: [...new Set(allowedEmails)],
      allowedEmailDomains: [...new Set(allowedEmailDomains)],
      sessionDurationHours,
    };
  }

  private toAccessPolicyDto(p: {
    id: string;
    organizationId: string;
    name: string;
    mode: string;
    rules: unknown;
    createdAt: Date;
    updatedAt: Date;
  }): AccessPolicyDto {
    return {
      id: p.id,
      organizationId: p.organizationId,
      name: p.name,
      mode: p.mode as AccessMode,
      rules: p.rules as AccessPolicyRules,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  async listAccessPolicies(userId: string, orgId: string): Promise<AccessPolicyDto[]> {
    await this.requireMembership(userId, orgId, 'VIEWER');
    const list = await this.prisma.accessPolicy.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    return list.map((p) => this.toAccessPolicyDto(p));
  }

  async createAccessPolicy(
    userId: string,
    orgId: string,
    input: { name: string; mode: AccessMode; rules: AccessPolicyRules },
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<AccessPolicyDto> {
    await this.requireMembership(userId, orgId, 'ADMIN');
    const nameRes = validateLabel(input.name, 'Policy name', 64);
    if (!nameRes.ok) throw new BadRequestException(nameRes.error);

    const normalizedRules = this.validateAndNormalizePolicyRules(input.mode, input.rules);

    const existing = await this.prisma.accessPolicy.findUnique({
      where: { organizationId_name: { organizationId: orgId, name: nameRes.value } },
    });
    if (existing) {
      throw new ConflictException(`Access policy "${nameRes.value}" already exists.`);
    }

    const created = await this.prisma.accessPolicy.create({
      data: {
        organizationId: orgId,
        name: nameRes.value,
        mode: input.mode,
        rules: normalizedRules as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'access_policy.created',
      targetType: 'access_policy',
      targetId: created.id,
      metadata: { name: created.name, mode: created.mode },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });

    return this.toAccessPolicyDto(created);
  }

  async deleteAccessPolicy(
    userId: string,
    orgId: string,
    policyId: string,
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<void> {
    await this.requireMembership(userId, orgId, 'ADMIN');
    const existing = await this.prisma.accessPolicy.findFirst({
      where: { id: policyId, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Access policy not found.');
    await this.prisma.accessPolicy.delete({ where: { id: policyId } });
    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'access_policy.deleted',
      targetType: 'access_policy',
      targetId: policyId,
      metadata: { name: existing.name },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Provider Connections (AES-256-GCM encrypted token storage)
  // ---------------------------------------------------------------------------

  async listProviderConnections(userId: string, orgId: string): Promise<ProviderConnectionDto[]> {
    await this.requireMembership(userId, orgId, 'VIEWER');
    const list = await this.prisma.providerConnection.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    return list.map((c) => ({
      id: c.id,
      provider: c.provider,
      label: c.label,
      accountId: c.accountId,
      tokenLast4: c.tokenLast4,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  async createProviderConnection(
    userId: string,
    orgId: string,
    input: { provider: string; label: string; accountId?: string; token: string },
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<ProviderConnectionDto> {
    await this.requireMembership(userId, orgId, 'ADMIN');
    const labelRes = validateLabel(input.label, 'Label', 64);
    if (!labelRes.ok) throw new BadRequestException(labelRes.error);
    const tok = (input.token ?? '').trim();
    if (tok.length < 16) {
      throw new BadRequestException('Provider API token must be at least 16 characters.');
    }

    const encryptedToken = encryptSecret(tok, this.encryptionKey);
    const tokenLast4 = tok.slice(-4);

    const created = await this.prisma.providerConnection.create({
      data: {
        organizationId: orgId,
        provider: 'cloudflare',
        label: labelRes.value,
        accountId: input.accountId?.trim() || null,
        encryptedToken,
        tokenLast4,
        createdById: userId,
      },
    });

    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'provider_connection.created',
      targetType: 'provider_connection',
      targetId: created.id,
      metadata: { label: created.label, tokenLast4 },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
      knownSecrets: [tok],
    });

    return {
      id: created.id,
      provider: created.provider,
      label: created.label,
      accountId: created.accountId,
      tokenLast4: created.tokenLast4,
      createdAt: created.createdAt.toISOString(),
    };
  }

  async deleteProviderConnection(
    userId: string,
    orgId: string,
    connectionId: string,
    ctx: { ip?: string; requestId?: string } = {},
  ): Promise<void> {
    await this.requireMembership(userId, orgId, 'ADMIN');
    const existing = await this.prisma.providerConnection.findFirst({
      where: { id: connectionId, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Provider connection not found.');
    await this.prisma.providerConnection.delete({ where: { id: connectionId } });
    await this.audit.record({
      organizationId: orgId,
      actorUserId: userId,
      action: 'provider_connection.deleted',
      targetType: 'provider_connection',
      targetId: connectionId,
      metadata: { label: existing.label },
      ipAddress: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Audit Events
  // ---------------------------------------------------------------------------

  private toAuditEventDto(e: {
    id: string;
    organizationId: string | null;
    actorUserId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: unknown;
    ipAddress: string | null;
    createdAt: Date;
    actor?: { email: string } | null;
  }): AuditEventDto {
    return {
      id: e.id,
      organizationId: e.organizationId,
      actorUserId: e.actorUserId,
      actorEmail: e.actor?.email ?? null,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      metadata: (e.metadata ?? {}) as Record<string, unknown>,
      ipAddress: e.ipAddress,
      createdAt: e.createdAt.toISOString(),
    };
  }

  async listAuditEvents(
    userId: string,
    orgId: string,
    query: { page?: number; pageSize?: number; action?: string },
  ): Promise<Paginated<AuditEventDto>> {
    await this.requireMembership(userId, orgId, 'VIEWER');
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)));

    const where: Prisma.AuditEventWhereInput = {
      organizationId: orgId,
      ...(query.action ? { action: query.action } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        include: { actor: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditEvent.count({ where }),
    ]);

    return {
      items: items.map((e) => this.toAuditEventDto(e)),
      page,
      pageSize,
      total,
    };
  }
}
