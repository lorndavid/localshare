import React, { useRef, useState } from 'react';
import gsap from 'gsap';
import { AlertCircle, Check, Copy } from 'lucide-react';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(value);
    } catch {
      // Ignore clipboard write denial in restricted/headless contexts
    }
    setCopied(true);
    if (btnRef.current && !prefersReducedMotion()) {
      gsap.fromTo(
        btnRef.current,
        { scale: 0.95 },
        { scale: 1, duration: 0.2, ease: 'power2.out' },
      );
    }
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={() => void handleCopy()}
      aria-label={label}
      className="ls-btn-secondary px-2.5 py-1 text-xs"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const upper = status.toUpperCase();
  let dotClass = 'bg-[#85857E]';
  let textClass = 'text-[var(--ls-text-secondary)] border-[var(--ls-border-strong)] bg-[var(--ls-surface-secondary)]';

  if (upper === 'ONLINE' || upper === 'VERIFIED' || upper === 'ACTIVE') {
    dotClass = 'bg-emerald-600 dark:bg-emerald-400';
    textClass =
      'text-emerald-800 dark:text-emerald-300 border-emerald-600/30 bg-emerald-500/10';
  } else if (
    upper === 'STARTING' ||
    upper === 'CONNECTING' ||
    upper === 'RECONNECTING' ||
    upper === 'PENDING_VERIFICATION' ||
    upper === 'PENDING_DNS'
  ) {
    dotClass = 'bg-amber-600 dark:bg-amber-400';
    textClass = 'text-amber-800 dark:text-amber-300 border-amber-600/30 bg-amber-500/10';
  } else if (upper === 'ERROR' || upper === 'FAILED' || upper === 'REVOKED') {
    dotClass = 'bg-red-600 dark:bg-red-400';
    textClass = 'text-red-800 dark:text-red-300 border-red-600/30 bg-red-500/10';
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[5px] border px-2 py-0.5 text-[11px] font-medium ${textClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="ls-surface p-8 text-center">
      <h3 className="text-sm font-semibold text-[var(--ls-text)]">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-xs text-[var(--ls-text-secondary)]">
        {description}
      </p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="ls-surface p-5 space-y-3" aria-busy="true" aria-label="Loading content">
      {Array.from({ length: rows }).map((_, idx) => (
        <div
          key={idx}
          className="h-9 w-full animate-pulse rounded-[6px] bg-[var(--ls-hover)]"
        />
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="ls-surface border-red-500/40 bg-red-500/5 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
    >
      <div className="flex items-start gap-2.5 text-xs text-red-700 dark:text-red-300">
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
        <span>{message}</span>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="ls-btn-secondary text-xs shrink-0">
          Try Again
        </button>
      )}
    </div>
  );
}

