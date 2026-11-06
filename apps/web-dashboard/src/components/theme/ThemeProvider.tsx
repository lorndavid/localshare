import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  setTheme: (next: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveThemeMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    try {
      const saved =
        typeof window !== 'undefined' ? window.localStorage.getItem('ls_theme') : null;
      if (saved === 'dark' || saved === 'light' || saved === 'system') {
        return saved;
      }
    } catch {
      // Ignore storage errors
    }
    return 'light';
  });

  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    resolveThemeMode(theme),
  );

  const applyDomTheme = useCallback((mode: ThemeMode) => {
    const resolved = resolveThemeMode(mode);
    setResolvedTheme(resolved);
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      if (resolved === 'dark') {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    }
  }, []);

  useEffect(() => {
    applyDomTheme(theme);
    try {
      window.localStorage.setItem('ls_theme', theme);
    } catch {
      // Ignore storage errors
    }

    if (theme === 'system' && typeof window !== 'undefined' && window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyDomTheme('system');
      mql.addEventListener?.('change', handler);
      return () => mql.removeEventListener?.('change', handler);
    }
    return undefined;
  }, [theme, applyDomTheme]);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const currentResolved = resolveThemeMode(prev);
      return currentResolved === 'dark' ? 'light' : 'dark';
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}

export function ThemeToggle({ showLabel = false }: { showLabel?: boolean }) {
  const { resolvedTheme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Toggle color theme"
      className="ls-btn-secondary"
    >
      {resolvedTheme === 'dark' ? (
        <>
          <Sun className="h-3.5 w-3.5" />
          {showLabel && <span>Light</span>}
        </>
      ) : (
        <>
          <Moon className="h-3.5 w-3.5" />
          {showLabel && <span>Dark</span>}
        </>
      )}
    </button>
  );
}

export function AppearanceSelector() {
  const { theme, setTheme } = useTheme();
  const options: ReadonlyArray<{ id: ThemeMode; label: string; icon: React.FC<{ className?: string }> }> = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ];

  return (
    <div className="inline-flex rounded-[8px] border border-[var(--ls-border-strong)] bg-[var(--ls-surface-secondary)] p-1 gap-1" role="group" aria-label="Appearance preference">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = theme === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => setTheme(opt.id)}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-medium transition-colors ${
              active
                ? 'bg-[var(--ls-btn-bg)] text-[var(--ls-btn-text)] shadow-xs'
                : 'text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

