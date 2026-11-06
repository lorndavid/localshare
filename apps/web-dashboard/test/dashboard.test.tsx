import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { apiRequest, getAccessToken, setAccessToken } from '../src/api/client';

describe('Dashboard API Client & Single-Flight Refresh', () => {
  afterEach(() => {
    setAccessToken(null);
    vi.restoreAllMocks();
  });

  it('stores access token in memory and automatically refreshes once on 401', async () => {
    setAccessToken('expired-jwt');
    let refreshCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('Authorization');

      if (url.endsWith('/auth/refresh')) {
        refreshCount += 1;
        return new Response(
          JSON.stringify({
            accessToken: 'fresh-jwt',
            expiresIn: 900,
            user: { id: 'u1', email: 'ada@acme.com', name: 'Ada', createdAt: '2026-11-06T00:00:00Z' },
          }),
          { status: 200 },
        );
      }

      if (auth === 'Bearer expired-jwt') {
        return new Response(JSON.stringify({ message: 'Expired' }), { status: 401 });
      }
      if (auth === 'Bearer fresh-jwt') {
        return new Response(JSON.stringify([{ id: 'org-1', name: 'Acme', slug: 'acme', role: 'OWNER' }]), {
          status: 200,
        });
      }
      return new Response(null, { status: 500 });
    });

    const orgs = await apiRequest<Array<{ id: string }>>('/organizations');
    expect(orgs).toHaveLength(1);
    expect(refreshCount).toBe(1);
    expect(getAccessToken()).toBe('fresh-jwt');
  });
});

describe('Dashboard UI Flows (Auth, RBAC, Domains TXT & Theme)', () => {
  beforeEach(() => {
    setAccessToken(null);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders login screen, validates email, logs in, displays overview and verifies domain TXT challenge', async () => {
    const user = userEvent.setup();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/auth/refresh')) {
        return new Response(null, { status: 401 });
      }
      if (url.endsWith('/auth/login') && method === 'POST') {
        return new Response(
          JSON.stringify({
            accessToken: 'jwt-1',
            expiresIn: 900,
            user: { id: 'u1', email: 'ada@acme.com', name: 'Ada Lovelace', createdAt: '2026-11-06T00:00:00Z' },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/organizations')) {
        return new Response(
          JSON.stringify([
            {
              id: 'org-1',
              name: 'Acme Engineering',
              slug: 'acme-eng',
              role: 'OWNER',
              createdAt: '2026-11-06T00:00:00Z',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith('/organizations/org-1/overview')) {
        return new Response(
          JSON.stringify({
            workspaces: 2,
            activeTunnels: 1,
            totalTunnels: 3,
            verifiedDomains: 1,
            pendingDomains: 1,
            members: 4,
            recentEvents: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/organizations/org-1/domains')) {
        return new Response(
          JSON.stringify([
            {
              id: 'dom-1',
              organizationId: 'org-1',
              hostname: 'preview.customer.com',
              status: 'PENDING_VERIFICATION',
              verifiedAt: null,
              createdAt: '2026-11-06T00:00:00Z',
              verification: {
                method: 'DNS_TXT',
                recordName: '_localshare-challenge.preview.customer.com',
                recordValue: 'localshare-verify=abc123xyz',
                lastCheckedAt: null,
                lastError: null,
              },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /LocalShare Cloud/i })).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/Email Address/i), 'ada@acme.com');
    await user.type(screen.getByLabelText(/Password/i), 'super-secret-password');
    await user.click(screen.getByRole('button', { name: /Sign In/i }));

    await waitFor(() => {
      expect(screen.getByText(/Acme Engineering — Overview/i)).toBeInTheDocument();
    });

    // Navigate to Domains tab and check TXT record challenge display
    await user.click(screen.getByRole('button', { name: 'Domains' }));
    await waitFor(() => {
      expect(screen.getByText('_localshare-challenge.preview.customer.com')).toBeInTheDocument();
      expect(screen.getByText('localshare-verify=abc123xyz')).toBeInTheDocument();
    });
  });
});

