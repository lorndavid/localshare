/**
 * Shared design tokens and tunnel status badge descriptors for LocalShare UI surfaces.
 */
import type { AccessMode, DomainStatus, TunnelState } from '@localshare/shared-types';

export const DESIGN_TOKENS = {
  spacingUnitPx: 4,
  radiusPx: { sm: 4, md: 6, lg: 8 },
  colors: {
    dark: {
      background: '#090d16',
      surface: '#111827',
      border: '#1e293b',
      text: '#f1f5f9',
      muted: '#94a3b8',
      accent: '#38bdf8',
    },
    light: {
      background: '#f8fafc',
      surface: '#ffffff',
      border: '#e2e8f0',
      text: '#0f172a',
      muted: '#475569',
      accent: '#0284c7',
    },
  },
} as const;

export interface BadgeDescriptor {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}

export function getTunnelStateBadge(state: TunnelState): BadgeDescriptor {
  switch (state) {
    case 'ONLINE':
      return { label: 'Online', tone: 'success' };
    case 'STARTING':
    case 'CONNECTING':
    case 'RECONNECTING':
      return { label: state.charAt(0) + state.slice(1).toLowerCase(), tone: 'info' };
    case 'ERROR':
      return { label: 'Error', tone: 'danger' };
    case 'STOPPING':
      return { label: 'Stopping', tone: 'warning' };
    case 'STOPPED':
      return { label: 'Stopped', tone: 'neutral' };
  }
}

export function getAccessModeBadge(mode: AccessMode): BadgeDescriptor {
  switch (mode) {
    case 'CLOUDFLARE_ACCESS':
      return { label: 'Cloudflare Access', tone: 'success' };
    case 'PASSWORD':
      return { label: 'Password Protected', tone: 'info' };
    case 'PUBLIC':
      return { label: 'Public Link', tone: 'warning' };
  }
}

export function getDomainStatusBadge(status: DomainStatus): BadgeDescriptor {
  switch (status) {
    case 'VERIFIED':
      return { label: 'Verified', tone: 'success' };
    case 'PENDING_VERIFICATION':
      return { label: 'Pending DNS TXT', tone: 'warning' };
    case 'FAILED':
    case 'REVOKED':
      return { label: status, tone: 'danger' };
  }
}

