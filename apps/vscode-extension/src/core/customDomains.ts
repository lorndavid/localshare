/**
 * Data types for connected custom domains and named tunnels stored in workspace/global state.
 */
import type { AccessMode } from '@localshare/shared-types';

export type CustomDomainStatus = 'PENDING_DNS' | 'DNS_RESOLVED' | 'VERIFIED_HTTPS' | 'ERROR';

export interface SavedCustomDomain {
  id: string;
  hostname: string;
  tunnelId: string;
  tunnelName: string;
  accountId: string;
  zoneId?: string;
  zoneName?: string;
  cnameTarget: string;
  localHost: string;
  localPort: number;
  accessMode: AccessMode;
  allowedEmails?: string[];
  allowedEmailDomains?: string[];
  status: CustomDomainStatus;
  lastVerifiedAt?: string;
  lastError?: string;
}

