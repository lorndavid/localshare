import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { ExternalLink, Radio, ShieldAlert, X } from 'lucide-react';
import type { AccessMode, TunnelDto, WorkspaceDto } from '@localshare/shared-types';
import { getSensitiveService, validateLabel, validatePort } from '@localshare/validation';
import { apiClient } from '../../api/client';
import { CopyButton, StatusBadge, prefersReducedMotion } from '../common/Primitives';

interface CreateShareDialogProps {
  open: boolean;
  orgId: string;
  workspaces: WorkspaceDto[];
  onClose: () => void;
  onCreated: (tunnel: TunnelDto) => void;
}

const DETECTED_SERVICE_PRESETS = [
  { port: 5173, framework: 'Vite / React', url: 'http://localhost:5173' },
  { port: 3000, framework: 'Next.js / Node', url: 'http://localhost:3000' },
  { port: 4500, framework: 'LocalShare Demo App', url: 'http://localhost:4500' },
  { port: 8000, framework: 'FastAPI / Python', url: 'http://localhost:8000' },
] as const;

export function CreateShareDialog({
  open,
  orgId,
  workspaces,
  onClose,
  onCreated,
}: CreateShareDialogProps) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [portInput, setPortInput] = useState<string>('5173');
  const [framework, setFramework] = useState<string>('Vite / React');
  const [shareName, setShareName] = useState<string>('Frontend Preview');
  const [subdomain, setSubdomain] = useState<string>('');
  const [accessMode, setAccessMode] = useState<AccessMode>('PUBLIC');
  const [confirmedExposure, setConfirmedExposure] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [createdTunnel, setCreatedTunnel] = useState<TunnelDto | null>(null);

  useEffect(() => {
    if (!open) {
      setError(null);
      setCreatedTunnel(null);
      setConfirmedExposure(false);
      setSubmitting(false);
      return;
    }
    if (workspaces.length > 0 && !workspaceId) {
      setWorkspaceId(workspaces[0]!.id);
    }
    if (modalRef.current && !prefersReducedMotion()) {
      gsap.fromTo(
        modalRef.current,
        { opacity: 0, y: 12, scale: 0.98 },
        { opacity: 1, y: 0, scale: 1, duration: 0.24, ease: 'power2.out' },
      );
    }
  }, [open, workspaces, workspaceId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const nameRes = validateLabel(shareName, 'Share name', 64);
    if (!nameRes.ok) {
      setError(nameRes.error);
      return;
    }

    const portRes = validatePort(portInput);
    if (!portRes.ok) {
      setError(portRes.error);
      return;
    }

    const sensitive = getSensitiveService(portRes.value);
    if (sensitive) {
      setError(
        `Port ${portRes.value} (${sensitive.service}) is a sensitive infrastructure service and cannot be exposed publicly by default.`,
      );
      return;
    }

    if (accessMode === 'PUBLIC' && !confirmedExposure) {
      setError('Please confirm the public exposure warning before starting an unrestricted tunnel.');
      return;
    }

    const cleanSub =
      subdomain
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/^-+|-+$/g, '') ||
      `${nameRes.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 18)}-${portRes.value}`;

    const publicUrl = `https://${cleanSub}.lorndavid.online`;

    setSubmitting(true);
    try {
      const saved = await apiClient.upsertTunnel(orgId, {
        clientId: `web-${cleanSub}-${portRes.value}`,
        workspaceId: workspaceId || undefined,
        name: nameRes.value,
        kind: subdomain.trim() ? 'NAMED' : 'QUICK',
        provider: 'localshare',
        state: 'ONLINE',
        accessMode,
        localTarget: `localhost:${portRes.value}`,
        publicUrl,
        framework: framework || 'HTTP',
        startedAt: new Date().toISOString(),
      });
      setCreatedTunnel(saved);
      onCreated(saved);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "LocalShare couldn't register the tunnel share. Please check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-share-title"
    >
      <div
        ref={modalRef}
        className="ls-surface w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--ls-border)] pb-4">
          <div className="flex items-center gap-2.5">
            <Radio className="h-4 w-4 text-[var(--ls-text)]" />
            <h2 id="create-share-title" className="text-base font-semibold">
              Create New Share
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close create share dialog"
            className="rounded-[6px] p-1 text-[var(--ls-muted)] hover:bg-[var(--ls-hover)] hover:text-[var(--ls-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {createdTunnel ? (
          <div className="mt-5 space-y-5">
            <div className="ls-surface-secondary p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--ls-text-secondary)]">
                  Tunnel Status
                </span>
                <StatusBadge status={createdTunnel.state} />
              </div>
              <div>
                <div className="text-xs text-[var(--ls-muted)]">Public HTTPS URL</div>
                <div className="mt-1 flex items-center justify-between gap-2 rounded-[7px] border border-[var(--ls-border-strong)] bg-[var(--ls-surface)] p-2.5">
                  <code className="font-mono text-xs font-medium break-all">
                    {createdTunnel.publicUrl}
                  </code>
                  {createdTunnel.publicUrl && (
                    <CopyButton value={createdTunnel.publicUrl} label="Copy Public URL" />
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
                <div>
                  <span className="text-[var(--ls-muted)]">Local Target: </span>
                  <span className="font-mono font-medium">{createdTunnel.localTarget}</span>
                </div>
                <div>
                  <span className="text-[var(--ls-muted)]">Access: </span>
                  <span className="font-medium">{createdTunnel.accessMode}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              {createdTunnel.publicUrl && (
                <a
                  href={createdTunnel.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ls-btn-secondary"
                >
                  <span>Open URL</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              <button type="button" onClick={onClose} className="ls-btn-primary">
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
            {error && (
              <div
                role="alert"
                className="rounded-[7px] border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300"
              >
                {error}
              </div>
            )}

            {/* Step 1: Project Selection */}
            <div>
              <label htmlFor="share-project-select" className="block text-xs font-medium mb-1">
                1. Project Workspace
              </label>
              <select
                id="share-project-select"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className="ls-input w-full"
              >
                <option value="">Default Organization Workspace</option>
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Step 2: Local Service & Port */}
            <div>
              <label htmlFor="share-port-input" className="block text-xs font-medium mb-1">
                2. Local Development Port
              </label>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {DETECTED_SERVICE_PRESETS.map((preset) => (
                  <button
                    key={preset.port}
                    type="button"
                    onClick={() => {
                      setPortInput(String(preset.port));
                      setFramework(preset.framework);
                    }}
                    className={`rounded-[6px] border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      portInput === String(preset.port)
                        ? 'border-[var(--ls-text)] bg-[var(--ls-btn-bg)] text-[var(--ls-btn-text)]'
                        : 'border-[var(--ls-border-strong)] bg-[var(--ls-surface-secondary)] text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)]'
                    }`}
                  >
                    :{preset.port} ({preset.framework})
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <input
                  id="share-port-input"
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={portInput}
                  onChange={(e) => setPortInput(e.target.value)}
                  placeholder="5173"
                  className="ls-input w-full font-mono"
                />
                <input
                  type="text"
                  aria-label="Detected framework"
                  value={framework}
                  onChange={(e) => setFramework(e.target.value)}
                  placeholder="Framework (e.g. React, Next.js)"
                  className="ls-input w-full"
                />
              </div>
            </div>

            {/* Step 3: Share Configuration */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label htmlFor="share-name-input" className="block text-xs font-medium mb-1">
                  3. Share Name
                </label>
                <input
                  id="share-name-input"
                  type="text"
                  required
                  value={shareName}
                  onChange={(e) => setShareName(e.target.value)}
                  placeholder="Customer Checkout Preview"
                  className="ls-input w-full"
                />
              </div>
              <div>
                <label htmlFor="share-subdomain-input" className="block text-xs font-medium mb-1">
                  Subdomain (*.lorndavid.online)
                </label>
                <input
                  id="share-subdomain-input"
                  type="text"
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value)}
                  placeholder="Optional (e.g. demo-app)"
                  className="ls-input w-full font-mono"
                />
              </div>
            </div>

            <div>
              <label htmlFor="share-access-select" className="block text-xs font-medium mb-1">
                Access Protection
              </label>
              <select
                id="share-access-select"
                value={accessMode}
                onChange={(e) => setAccessMode(e.target.value as AccessMode)}
                className="ls-input w-full"
              >
                <option value="PUBLIC">Public HTTPS URL (Anyone with the link)</option>
                <option value="PASSWORD">Password Protected (LocalShare Gateway)</option>
                <option value="CLOUDFLARE_ACCESS">Identity Policy (Allowed Emails/Domains)</option>
              </select>
            </div>

            {/* Step 4: Public Exposure Confirmation */}
            {accessMode === 'PUBLIC' && (
              <div className="ls-surface-secondary p-3.5 space-y-2.5 border-amber-500/40">
                <div className="flex items-start gap-2 text-xs text-[var(--ls-text)]">
                  <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                  <span>
                    Anyone who can access an unrestricted public URL may be able to access your
                    local application.
                  </span>
                </div>
                <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmedExposure}
                    onChange={(e) => setConfirmedExposure(e.target.checked)}
                    className="rounded border-[var(--ls-border-strong)]"
                  />
                  <span>I understand and confirm public exposure of port {portInput || '—'}</span>
                </label>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--ls-border)]">
              <button type="button" onClick={onClose} className="ls-btn-secondary">
                Cancel
              </button>
              <button type="submit" disabled={submitting} className="ls-btn-primary">
                <Radio className="h-3.5 w-3.5" />
                <span>{submitting ? 'Starting Share…' : 'Start Sharing'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
