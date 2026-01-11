/**
 * Theme management for the web dashboard.
 *
 * @module utils/theme
 */

import { writable, derived, get } from 'svelte/store';

// =============================================================================
// Types
// =============================================================================

export type ThemeName = 'dark' | 'light';

export interface ThemeColors {
  readonly primary: string;
  readonly primaryHover: string;
  readonly secondary: string;
  readonly secondaryHover: string;
  readonly success: string;
  readonly successMuted: string;
  readonly warning: string;
  readonly warningMuted: string;
  readonly error: string;
  readonly errorMuted: string;
  readonly info: string;
  readonly infoMuted: string;
  readonly text: string;
  readonly textMuted: string;
  readonly textInverse: string;
  readonly background: string;
  readonly backgroundElevated: string;
  readonly backgroundSunken: string;
  readonly backgroundOverlay: string;
  readonly border: string;
  readonly borderMuted: string;
  readonly borderFocus: string;
  readonly hover: string;
  readonly active: string;
  readonly selected: string;
  readonly statusRunning: string;
  readonly statusStopping: string;
  readonly statusStopped: string;
  readonly statusConnected: string;
  readonly statusConnecting: string;
  readonly statusDisconnected: string;
  readonly gaugeBackground: string;
  readonly gaugeForeground: string;
  readonly gaugeWarning: string;
  readonly gaugeCritical: string;
  readonly shadowColor: string;
}

export interface Theme {
  readonly name: ThemeName;
  readonly colors: ThemeColors;
}

// =============================================================================
// Theme Definitions
// =============================================================================

const DARK_COLORS: ThemeColors = {
  primary: '#22d3ee',
  primaryHover: '#67e8f9',
  secondary: '#3b82f6',
  secondaryHover: '#60a5fa',
  success: '#22c55e',
  successMuted: 'rgba(34, 197, 94, 0.2)',
  warning: '#eab308',
  warningMuted: 'rgba(234, 179, 8, 0.2)',
  error: '#ef4444',
  errorMuted: 'rgba(239, 68, 68, 0.2)',
  info: '#3b82f6',
  infoMuted: 'rgba(59, 130, 246, 0.2)',
  text: '#f8fafc',
  textMuted: '#94a3b8',
  textInverse: '#0f172a',
  background: '#0f172a',
  backgroundElevated: '#1e293b',
  backgroundSunken: '#020617',
  backgroundOverlay: 'rgba(15, 23, 42, 0.9)',
  border: '#334155',
  borderMuted: '#1e293b',
  borderFocus: '#22d3ee',
  hover: 'rgba(255, 255, 255, 0.05)',
  active: 'rgba(255, 255, 255, 0.1)',
  selected: 'rgba(34, 211, 238, 0.15)',
  statusRunning: '#22c55e',
  statusStopping: '#eab308',
  statusStopped: '#64748b',
  statusConnected: '#22c55e',
  statusConnecting: '#eab308',
  statusDisconnected: '#ef4444',
  gaugeBackground: '#1e293b',
  gaugeForeground: '#22d3ee',
  gaugeWarning: '#eab308',
  gaugeCritical: '#ef4444',
  shadowColor: 'rgba(0, 0, 0, 0.5)',
};

const LIGHT_COLORS: ThemeColors = {
  primary: '#0891b2',
  primaryHover: '#0e7490',
  secondary: '#2563eb',
  secondaryHover: '#1d4ed8',
  success: '#16a34a',
  successMuted: 'rgba(22, 163, 74, 0.15)',
  warning: '#ca8a04',
  warningMuted: 'rgba(202, 138, 4, 0.15)',
  error: '#dc2626',
  errorMuted: 'rgba(220, 38, 38, 0.15)',
  info: '#2563eb',
  infoMuted: 'rgba(37, 99, 235, 0.15)',
  text: '#0f172a',
  textMuted: '#64748b',
  textInverse: '#f8fafc',
  background: '#ffffff',
  backgroundElevated: '#f8fafc',
  backgroundSunken: '#f1f5f9',
  backgroundOverlay: 'rgba(255, 255, 255, 0.95)',
  border: '#e2e8f0',
  borderMuted: '#f1f5f9',
  borderFocus: '#0891b2',
  hover: 'rgba(0, 0, 0, 0.03)',
  active: 'rgba(0, 0, 0, 0.06)',
  selected: 'rgba(8, 145, 178, 0.1)',
  statusRunning: '#16a34a',
  statusStopping: '#ca8a04',
  statusStopped: '#94a3b8',
  statusConnected: '#16a34a',
  statusConnecting: '#ca8a04',
  statusDisconnected: '#dc2626',
  gaugeBackground: '#e2e8f0',
  gaugeForeground: '#0891b2',
  gaugeWarning: '#ca8a04',
  gaugeCritical: '#dc2626',
  shadowColor: 'rgba(0, 0, 0, 0.1)',
};

const THEMES: Record<ThemeName, Theme> = {
  dark: { name: 'dark', colors: DARK_COLORS },
  light: { name: 'light', colors: LIGHT_COLORS },
};

// =============================================================================
// CSS Custom Properties
// =============================================================================

function colorKeyToCssVar(key: string): string {
  return '--color-' + key.replace(/([A-Z])/g, '-$1').toLowerCase();
}

function applyThemeToElement(element: HTMLElement, theme: Theme): void {
  for (const [key, value] of Object.entries(theme.colors)) {
    element.style.setProperty(colorKeyToCssVar(key), value);
  }
  element.setAttribute('data-theme', theme.name);
}

// =============================================================================
// Theme Store
// =============================================================================

const STORAGE_KEY = 'noex-dashboard-theme';

function getInitialTheme(): ThemeName {
  if (typeof window === 'undefined') return 'dark';
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeName | null;
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {}
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function createThemeStore() {
  const currentTheme = writable<ThemeName>(getInitialTheme());
  const isDark = derived(currentTheme, ($t) => $t === 'dark');
  const isLight = derived(currentTheme, ($t) => $t === 'light');
  const theme = derived(currentTheme, ($t) => THEMES[$t]);
  const colors = derived(theme, ($t) => $t.colors);

  function applyCurrentTheme(): void {
    if (typeof document === 'undefined') return;
    applyThemeToElement(document.documentElement, THEMES[get(currentTheme)]);
  }

  function setTheme(name: ThemeName): void {
    if (name === get(currentTheme)) return;
    currentTheme.set(name);
    applyCurrentTheme();
    try { localStorage.setItem(STORAGE_KEY, name); } catch {}
  }

  function toggle(): void {
    setTheme(get(currentTheme) === 'dark' ? 'light' : 'dark');
  }

  function initialize(): () => void {
    applyCurrentTheme();
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (e: MediaQueryListEvent): void => {
        try {
          if (!localStorage.getItem(STORAGE_KEY)) {
            currentTheme.set(e.matches ? 'dark' : 'light');
            applyCurrentTheme();
          }
        } catch {
          currentTheme.set(e.matches ? 'dark' : 'light');
          applyCurrentTheme();
        }
      };
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
    return () => {};
  }

  return {
    // Stores
    currentTheme,
    isDark,
    isLight,
    theme,
    colors,
    // Methods
    setTheme,
    toggle,
    initialize,
  };
}

export const themeStore = createThemeStore();
export { createThemeStore, THEMES, DARK_COLORS, LIGHT_COLORS };

export function cssVar(name: string): string {
  const kebabName = name.replace(/([A-Z])/g, '-$1').toLowerCase();
  return `var(--color-${kebabName})`;
}
