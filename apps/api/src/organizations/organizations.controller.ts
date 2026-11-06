import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  ACCESS_MODES,
  ORG_ROLES,
  TUNNEL_KINDS,
  TUNNEL_PROVIDERS,
  TUNNEL_STATES,
  type AccessMode,
  type AccessPolicyDto,
  type AuditEventDto,
  type DomainDto,
  type MemberDto,
  type OrgRole,
  type OrganizationDto,
  type OrganizationOverviewDto,
  type Paginated,
  type TunnelDto,
  type TunnelKind,
  type TunnelProviderId,
  type TunnelState,
  type WorkspaceDto,
} from '@localshare/shared-types';
import { type AuthenticatedRequest, BearerAuthGuard } from '../auth/auth.guard';
import {
  OrganizationsService,
  type ProviderConnectionDto,
} from './organizations.service';

export class CreateOrganizationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  slug?: string;
}

export class UpdateOrganizationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name: string;
}

export class AddMemberDto {
  @IsString()
  @MaxLength(254)
  email: string;

  @IsIn(ORG_ROLES)
  role: OrgRole;
}

export class UpdateMemberRoleDto {
  @IsIn(ORG_ROLES)
  role: OrgRole;
}

export class CreateWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateWorkspaceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpsertTunnelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  clientId: string;

  @IsOptional()
  @IsString()
  workspaceId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name: string;

  @IsIn(TUNNEL_KINDS)
  kind: TunnelKind;

  @IsIn(TUNNEL_PROVIDERS)
  provider: TunnelProviderId;

  @IsIn(TUNNEL_STATES)
  state: TunnelState;

  @IsIn(ACCESS_MODES)
  accessMode: AccessMode;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  localTarget: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  publicUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  framework?: string | null;

  @IsOptional()
  @IsString()
  startedAt?: string | null;

  @IsOptional()
  @IsString()
  stoppedAt?: string | null;
}

export class CreateDomainDto {
  @IsString()
  @MinLength(3)
  @MaxLength(253)
  hostname: string;
}

export class AccessPolicyRulesDto {
  @IsArray()
  @IsString({ each: true })
  allowedEmails: string[];

  @IsArray()
  @IsString({ each: true })
  allowedEmailDomains: string[];

  @IsInt()
  @Min(1)
  @Max(168)
  sessionDurationHours: number;
}

export class CreateAccessPolicyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name: string;

  @IsIn(ACCESS_MODES)
  mode: AccessMode;

  @ValidateNested()
  @Type(() => AccessPolicyRulesDto)
  rules: AccessPolicyRulesDto;
}

export class CreateProviderConnectionDto {
  @IsIn(['cloudflare'])
  provider: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  label: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  accountId?: string;

  @IsString()
  @MinLength(16)
  @MaxLength(512)
  token: string;
}

@ApiTags('organizations')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  @ApiOperation({ summary: 'List organizations the current user belongs to' })
  listOrganizations(@Req() req: AuthenticatedRequest): Promise<OrganizationDto[]> {
    return this.orgs.listOrganizations(req.user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new organization (caller becomes OWNER)' })
  createOrganization(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateOrganizationDto,
  ): Promise<OrganizationDto> {
    return this.orgs.createOrganization(req.user.userId, body, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Get(':orgId')
  @ApiOperation({ summary: 'Get organization details' })
  getOrganization(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<OrganizationDto> {
    return this.orgs.getOrganization(req.user.userId, orgId);
  }

  @Patch(':orgId')
  @ApiOperation({ summary: 'Rename an organization (ADMIN+)' })
  updateOrganization(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: UpdateOrganizationDto,
  ): Promise<OrganizationDto> {
    return this.orgs.updateOrganization(req.user.userId, orgId, body, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Delete(':orgId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete an organization (OWNER only)' })
  deleteOrganization(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<void> {
    return this.orgs.deleteOrganization(req.user.userId, orgId, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Get(':orgId/overview')
  @ApiOperation({ summary: 'Get real-time counts and recent activity for an organization' })
  getOverview(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<OrganizationOverviewDto> {
    return this.orgs.getOverview(req.user.userId, orgId);
  }

  // Members
  @Get(':orgId/members')
  @ApiOperation({ summary: 'List organization members' })
  listMembers(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<MemberDto[]> {
    return this.orgs.listMembers(req.user.userId, orgId);
  }

  @Post(':orgId/members')
  @ApiOperation({ summary: 'Add an existing user to the organization by email (ADMIN+)' })
  addMember(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: AddMemberDto,
  ): Promise<MemberDto> {
    return this.orgs.addMember(req.user.userId, orgId, body, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Patch(':orgId/members/:memberId')
  @ApiOperation({ summary: 'Update a member role (ADMIN+)' })
  updateMemberRole(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() body: UpdateMemberRoleDto,
  ): Promise<MemberDto> {
    return this.orgs.updateMemberRole(req.user.userId, orgId, memberId, body, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Delete(':orgId/members/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member from the organization (ADMIN+)' })
  removeMember(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<void> {
    return this.orgs.removeMember(req.user.userId, orgId, memberId, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  // Workspaces
  @Get(':orgId/workspaces')
  @ApiOperation({ summary: 'List workspaces in the organization' })
  listWorkspaces(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<WorkspaceDto[]> {
    return this.orgs.listWorkspaces(req.user.userId, orgId);
  }

  @Post(':orgId/workspaces')
  @ApiOperation({ summary: 'Create a workspace (MEMBER+)' })
  createWorkspace(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: CreateWorkspaceDto,
  ): Promise<WorkspaceDto> {
    return this.orgs.createWorkspace(req.user.userId, orgId, body, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Patch(':orgId/workspaces/:workspaceId')
  @ApiOperation({ summary: 'Update a workspace (MEMBER+)' })
  updateWorkspace(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() body: UpdateWorkspaceDto,
  ): Promise<WorkspaceDto> {
    return this.orgs.updateWorkspace(req.user.userId, orgId, workspaceId, body);
  }

  @Delete(':orgId/workspaces/:workspaceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a workspace (MEMBER+)' })
  deleteWorkspace(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<void> {
    return this.orgs.deleteWorkspace(req.user.userId, orgId, workspaceId, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  // Tunnels
  @Get(':orgId/tunnels')
  @ApiOperation({ summary: 'List tunnel metadata records (paginated)' })
  listTunnels(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('state') state?: string,
    @Query('workspaceId') workspaceId?: string,
  ): Promise<Paginated<TunnelDto>> {
    return this.orgs.listTunnels(req.user.userId, orgId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      state,
      workspaceId,
    });
  }

  @Get(':orgId/tunnels/:tunnelId')
  @ApiOperation({ summary: 'Get a single tunnel metadata record' })
  getTunnel(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('tunnelId', ParseUUIDPipe) tunnelId: string,
  ): Promise<TunnelDto> {
    return this.orgs.getTunnel(req.user.userId, orgId, tunnelId);
  }

  @Put(':orgId/tunnels')
  @ApiOperation({ summary: 'Idempotently upsert tunnel metadata by clientId (MEMBER+)' })
  upsertTunnel(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: UpsertTunnelDto,
  ): Promise<TunnelDto> {
    return this.orgs.upsertTunnel(req.user.userId, orgId, body);
  }

  @Delete(':orgId/tunnels/:tunnelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a tunnel metadata record (MEMBER+)' })
  deleteTunnel(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('tunnelId', ParseUUIDPipe) tunnelId: string,
  ): Promise<void> {
    return this.orgs.deleteTunnel(req.user.userId, orgId, tunnelId);
  }

  // Domains
  @Get(':orgId/domains')
  @ApiOperation({ summary: 'List custom domains and DNS verification challenges' })
  listDomains(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<DomainDto[]> {
    return this.orgs.listDomains(req.user.userId, orgId);
  }

  @Post(':orgId/domains')
  @ApiOperation({ summary: 'Register a custom hostname and generate a DNS TXT challenge (ADMIN+)' })
  createDomain(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: CreateDomainDto,
  ): Promise<DomainDto> {
    return this.orgs.createDomain(req.user.userId, orgId, body, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Post(':orgId/domains/:domainId/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @ApiOperation({ summary: 'Perform live DNS TXT lookup to verify domain ownership (ADMIN+)' })
  verifyDomain(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ): Promise<DomainDto> {
    return this.orgs.verifyDomain(req.user.userId, orgId, domainId, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Delete(':orgId/domains/:domainId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a custom domain (ADMIN+)' })
  deleteDomain(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ): Promise<void> {
    return this.orgs.deleteDomain(req.user.userId, orgId, domainId, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  // Access Policies
  @Get(':orgId/access-policies')
  @ApiOperation({ summary: 'List access policies in the organization' })
  listAccessPolicies(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<AccessPolicyDto[]> {
    return this.orgs.listAccessPolicies(req.user.userId, orgId);
  }

  @Post(':orgId/access-policies')
  @ApiOperation({ summary: 'Create an access policy (ADMIN+)' })
  createAccessPolicy(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: CreateAccessPolicyDto,
  ): Promise<AccessPolicyDto> {
    return this.orgs.createAccessPolicy(req.user.userId, orgId, body, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Delete(':orgId/access-policies/:policyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an access policy (ADMIN+)' })
  deleteAccessPolicy(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('policyId', ParseUUIDPipe) policyId: string,
  ): Promise<void> {
    return this.orgs.deleteAccessPolicy(req.user.userId, orgId, policyId, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  // Provider Connections
  @Get(':orgId/provider-connections')
  @ApiOperation({ summary: 'List connected tunnel provider accounts (tokens never returned)' })
  listProviderConnections(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<ProviderConnectionDto[]> {
    return this.orgs.listProviderConnections(req.user.userId, orgId);
  }

  @Post(':orgId/provider-connections')
  @ApiOperation({ summary: 'Save an encrypted provider API token (ADMIN+)' })
  createProviderConnection(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: CreateProviderConnectionDto,
  ): Promise<ProviderConnectionDto> {
    return this.orgs.createProviderConnection(req.user.userId, orgId, body, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  @Delete(':orgId/provider-connections/:connectionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a provider connection (ADMIN+)' })
  deleteProviderConnection(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ): Promise<void> {
    return this.orgs.deleteProviderConnection(req.user.userId, orgId, connectionId, {
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  // Audit Events
  @Get(':orgId/audit-events')
  @ApiOperation({ summary: 'List organization security audit events (paginated)' })
  listAuditEvents(
    @Req() req: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('action') action?: string,
  ): Promise<Paginated<AuditEventDto>> {
    return this.orgs.listAuditEvents(req.user.userId, orgId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      action,
    });
  }
}

