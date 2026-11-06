import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { apiRequest, getAccessToken, setAccessToken } from '../src/api/client';

describe('Dashboard API Client & Single-Flight Refresh', () => {
  afterEach(() => {
    cleanup();
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

describe('Dashboard UI Flows (Auth, RBAC, Create Share, Tunnels, Domains & Theme)', () => {
  beforeEach(() => {
    setAccessToken(null);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function createDashboardFetchMock() {
    const tunnels = [
      {
        id: 'tun-1',
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        name: 'storefront-web',
        kind: 'HTTP',
        provider: 'LOCALSHARE',
        state: 'ONLINE',
        accessMode: 'PUBLIC',
        localTarget: 'http://localhost:3000',
        publicUrl: 'https://storefront-web.lorndavid.online',
        framework: 'Next.js',
        startedAt: '2026-11-06T01:00:00Z',
        stoppedAt: null,
        lastHeartbeatAt: '2026-11-06T02:00:00Z',
        createdAt: '2026-11-06T01:00:00Z',
      },
    ];

    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
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
            activeTunnels: tunnels.filter((t) => t.state === 'ONLINE').length,
            totalTunnels: tunnels.length,
            verifiedDomains: 1,
            pendingDomains: 1,
            members: 4,
            recentEvents: [
              {
                id: 'evt-1',
                organizationId: 'org-1',
                actorUserId: 'u1',
                actorEmail: 'ada@acme.com',
                action: 'tunnel.started',
                resourceType: 'tunnel',
                resourceId: 'tun-1',
                ipAddress: '127.0.0.1',
                metadata: {},
                createdAt: '2026-11-06T02:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/organizations/org-1/workspaces')) {
        return new Response(
          JSON.stringify([
            {
              id: 'ws-1',
              organizationId: 'org-1',
              name: 'Storefront Web',
              slug: 'storefront-web',
              description: 'Customer frontend application',
              createdAt: '2026-11-06T00:00:00Z',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/organizations/org-1/tunnels') && method === 'GET') {
        return new Response(
          JSON.stringify({
            items: tunnels,
            total: tunnels.length,
            page: 1,
            pageSize: 50,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/organizations/org-1/tunnels') && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          workspaceId?: string;
          name: string;
          localTarget: string;
          publicUrl?: string;
          accessMode?: string;
          state?: string;
        };
        const existing = tunnels.find((t) => t.name === body.name);
        if (existing) {
          existing.state = body.state ?? existing.state;
          return new Response(JSON.stringify(existing), { status: 200 });
        }
        const created = {
          id: `tun-${tunnels.length + 1}`,
          organizationId: 'org-1',
          workspaceId: body.workspaceId ?? 'ws-1',
          name: body.name,
          kind: 'HTTP',
          provider: 'LOCALSHARE',
          state: body.state ?? 'ONLINE',
          accessMode: body.accessMode ?? 'PUBLIC',
          localTarget: body.localTarget,
          publicUrl: body.publicUrl ?? `https://${body.name}.lorndavid.online`,
          framework: 'Vite',
          startedAt: '2026-11-06T03:00:00Z',
          stoppedAt: null,
          lastHeartbeatAt: '2026-11-06T03:00:00Z',
          createdAt: '2026-11-06T03:00:00Z',
        };
        tunnels.unshift(created);
        return new Response(JSON.stringify(created), { status: 200 });
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
  }

  it('renders login screen, logs in, displays overview metrics, and verifies domain TXT challenge', async () => {
    const user = userEvent.setup();
    createDashboardFetchMock();

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

    expect(screen.getByText('Active Tunnels')).toBeInTheDocument();
    expect(screen.getByText('Online Tunnels')).toBeInTheDocument();
    expect(screen.getAllByText('Custom Domains').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Shares This Month')).toBeInTheDocument();

    // Navigate to Domains tab and check TXT record challenge display
    await user.click(screen.getByRole('button', { name: 'Domains' }));
    await waitFor(() => {
      expect(screen.getByText('_localshare-challenge.preview.customer.com')).toBeInTheDocument();
      expect(screen.getByText('localshare-verify=abc123xyz')).toBeInTheDocument();
    });
  });

  it('validates Create Share modal (blocks sensitive port, requires confirmation) and creates a share', async () => {
    const user = userEvent.setup();
    createDashboardFetchMock();

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

    // Open New Share modal
    await user.click(screen.getAllByRole('button', { name: /New Share/i })[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /Create New Share/i })).toBeInTheDocument();

    // Test sensitive port guard (PostgreSQL 5432)
    const portInput = within(dialog).getByLabelText(/2\. Local Development Port/i);
    await user.clear(portInput);
    await user.type(portInput, '5432');

    // Check confirmation checkbox and submit
    const confirmCheckbox = within(dialog).getByRole('checkbox');
    await user.click(confirmCheckbox);
    await user.click(within(dialog).getByRole('button', { name: /Start Sharing/i }));

    await waitFor(() => {
      expect(
        within(dialog).getByText(
          /Port 5432 \(PostgreSQL\) is a sensitive infrastructure service/i,
        ),
      ).toBeInTheDocument();
    });

    // Select a valid port (:5173) and create share
    await user.click(within(dialog).getByRole('button', { name: /:5173 \(Vite \/ React\)/i }));
    await user.type(within(dialog).getByLabelText(/Subdomain/i), 'vite-preview');
    await user.click(within(dialog).getByRole('button', { name: /Start Sharing/i }));

    await waitFor(() => {
      expect(within(dialog).getByText(/Public HTTPS URL/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/https:\/\/vite-preview\.lorndavid\.online/i)).toBeInTheDocument();
    });
  });

  it('persists theme selection across Light, Dark, and System modes in Settings', async () => {
    const user = userEvent.setup();
    createDashboardFetchMock();

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

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Appearance/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(window.localStorage.getItem('ls_theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(window.localStorage.getItem('ls_theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'System' }));
    expect(window.localStorage.getItem('ls_theme')).toBe('system');
  });

  it('filters tunnels by search query and toggles tunnel state (Stop / Restart)', async () => {
    const user = userEvent.setup();
    createDashboardFetchMock();

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

    await user.click(screen.getByRole('button', { name: 'Tunnels' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Tunnel Inventory/i })).toBeInTheDocument();
      expect(screen.getByText('storefront-web')).toBeInTheDocument();
    });

    // Search filter
    const searchInput = screen.getByLabelText(/Search tunnels/i);
    await user.type(searchInput, 'non-existent-share');
    expect(screen.getByText(/No tunnel records found/i)).toBeInTheDocument();

    await user.clear(searchInput);
    expect(screen.getByText('storefront-web')).toBeInTheDocument();

    // Stop active tunnel
    await user.click(screen.getByRole('button', { name: /Stop tunnel storefront-web/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Restart tunnel storefront-web/i })).toBeInTheDocument();
    });
  });
});
