/**
 * Theme management for the web dashboard.
 *
 * Provides CSS custom properties based theming with reactive theme state.
 * Supports dark and light modes with smooth transitions and system preference detection.
 *
 * @module utils/theme
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Available theme names.
 */
export type ThemeName = 'dark' | 'light';

/**
 * Theme color palette definition.
 */
export interface ThemeColors {
  // Core palette
  readonly primary: string;
  readonly primaryHover: string;
  readonly secondary: string;
  readonly secondaryHover: string;

  // Semantic colors
  readonly success: string;
  readonly successMuted: string;
  readonly warning: string;
  readonly warningMuted: string;
  readonly error: string;
  readonly errorMuted: string;
  readonly info: string;
  readonly infoMuted: string;

  // Text colors
  readonly text: string;
  readonly textMuted: string;
  readonly textInverse: string;

  // Background layers
  readonly background: string;
  readonly backgroundElevated: string;
  readonly backgroundSunken: string;
  readonly backgroundOverlay: string;

  // Border colors
  readonly border: string;
  readonly borderMuted: string;
  readonly borderFocus: string;

  // Interactive states
  readonly hover: string;
  readonly active: string;
  readonly selected: string;

  // Status indicator colors
  readonly statusRunning: string;
  readonly statusStopping: string;
  readonly statusStopped: string;
  readonly statusConnected: string;
  readonly statusConnecting: string;
  readonly statusDisconnected: string;

  // Widget specific
  readonly gaugeBackground: string;
  readonly gaugeForeground: string;
  readonly gaugeWarning: string;
  readonly gaugeCritical: string;

  // Shadows
  readonly shadowColor: string;
}

/**
 * Complete theme configuration.
 */
export interface Theme {
  readonly name: ThemeName;
  readonly colors: ThemeColors;
}

// =============================================================================
// Theme Definitions
// =============================================================================

/**
 * Dark theme color palette.
 *
 * Optimized for low-light environments with high contrast.
 */
const DARK_COLORS: ThemeColors = {
  // Core palette - cyan as primary for noex branding
  primary: '#22d3ee',
  primaryHover: '#67e8f9',
  secondary: '#3b82f6',
  secondaryHover: '#60a5fa',

  // Semantic colors
  success: '#22c55e',
  successMuted: 'rgba(34, 197, 94, 0.2)',
  warning: '#eab308',
  warningMuted: 'rgba(234, 179, 8, 0.2)',
  error: '#ef4444',
  errorMuted: 'rgba(239, 68, 68, 0.2)',
  info: '#3b82f6',
  infoMuted: 'rgba(59, 130, 246, 0.2)',

  // Text colors
  text: '#f8fafc',
  textMuted: '#94a3b8',
  textInverse: '#0f172a',

  // Background layers
  background: '#0f172a',
  backgroundElevated: '#1e293b',
  backgroundSunken: '#020617',
  backgroundOverlay: 'rgba(15, 23, 42, 0.9)',

  // Border colors
  border: '#334155',
  borderMuted: '#1e293b',
  borderFocus: '#22d3ee',

  // Interactive states
  hover: 'rgba(255, 255, 255, 0.05)',
  active: 'rgba(255, 255, 255, 0.1)',
  selected: 'rgba(34, 211, 238, 0.15)',

  // Status indicators
  statusRunning: '#22c55e',
  statusStopping: '#eab308',
  statusStopped: '#64748b',
  statusConnected: '#22c55e',
  statusConnecting: '#eab308',
  statusDisconnected: '#ef4444',

  // Widget specific
  gaugeBackground: '#1e293b',
  gaugeForeground: '#22d3ee',
  gaugeWarning: '#eab308',
  gaugeCritical: '#ef4444',

  // Shadows
  shadowColor: 'rgba(0, 0, 0, 0.5)',
};

/**
 * Light theme color palette.
 *
 * Clean, professional appearance for well-lit environments.
 */
const LIGHT_COLORS: ThemeColors = {
  // Core palette - blue as primary for light mode
  primary: '#0891b2',
  primaryHover: '#0e7490',
  secondary: '#2563eb',
  secondaryHover: '#1d4ed8',

  // Semantic colors
  success: '#16a34a',
  successMuted: 'rgba(22, 163, 74, 0.15)',
  warning: '#ca8a04',
  warningMuted: 'rgba(202, 138, 4, 0.15)',
  error: '#dc2626',
  errorMuted: 'rgba(220, 38, 38, 0.15)',
  info: '#2563eb',
  infoMuted: 'rgba(37, 99, 235, 0.15)',

  // Text colors
  text: '#0f172a',
  textMuted: '#64748b',
  textInverse: '#f8fafc',

  // Background layers
  background: '#ffffff',
  backgroundElevated: '#f8fafc',
  backgroundSunken: '#f1f5f9',
  backgroundOverlay: 'rgba(255, 255, 255, 0.95)',

  // Border colors
  border: '#e2e8f0',
  borderMuted: '#f1f5f9',
  borderFocus: '#0891b2',

  // Interactive states
  hover: 'rgba(0, 0, 0, 0.03)',
  active: 'rgba(0, 0, 0, 0.06)',
  selected: 'rgba(8, 145, 178, 0.1)',

  // Status indicators
  statusRunning: '#16a34a',
  statusStopping: '#ca8a04',
  statusStopped: '#94a3b8',
  statusConnected: '#16a34a',
  statusConnecting: '#ca8a04',
  statusDisconnected: '#dc2626',

  // Widget specific
  gaugeBackground: '#e2e8f0',
  gaugeForeground: '#0891b2',
  gaugeWarning: '#ca8a04',
  gaugeCritical: '#dc2626',

  // Shadows
  shadowColor: 'rgba(0, 0, 0, 0.1)',
};

/**
 * Theme registry.
 */
const THEMES: Record<ThemeName, Theme> = {
  dark: { name: 'dark', colors: DARK_COLORS },
  light: { name: 'light', colors: LIGHT_COLORS },
};

// =============================================================================
// CSS Custom Properties
// =============================================================================

/**
 * Converts a color key to a CSS custom property name.
 */
function colorKeyToCssVar(key: string): string {
  // Convert camelCase to kebab-case: primaryHover -> primary-hover
  return '--color-' + key.replace(/([A-Z])/g, '-$1').toLowerCase();
}

/**
 * Generates CSS custom properties string from theme colors.
 *
 * @param colors - Theme color palette
 * @returns CSS custom properties declaration
 */
function generateCssVariables(colors: ThemeColors): string {
  return Object.entries(colors)
    .map(([key, value]) => `${colorKeyToCssVar(key)}: ${value};`)
    .join('\n  ');
}

/**
 * Applies theme CSS custom properties to an element.
 *
 * @param element - Target element (typically document.documentElement)
 * @param theme - Theme to apply
 */
function applyThemeToElement(element: HTMLElement, theme: Theme): void {
  for (const [key, value] of Object.entries(theme.colors)) {
    element.style.setProperty(colorKeyToCssVar(key), value);
  }
  element.setAttribute('data-theme', theme.name);
}

// =============================================================================
// Theme Store
// =============================================================================

/**
 * Storage key for persisted theme preference.
 */
const STORAGE_KEY = 'noex-dashboard-theme';

/**
 * Creates a reactive theme store using Svelte 5 runes.
 *
 * Features:
 * - System preference detection via prefers-color-scheme
 * - Persistent storage of user preference
 * - Automatic CSS variable injection
 * - Reactive theme switching
 *
 * @example
 * ```typescript
 * const theme = createThemeStore();
 *
 * // Toggle between themes
 * theme.toggle();
 *
 * // Set specific theme
 * theme.setTheme('light');
 *
 * // Access current theme
 * console.log(theme.current);    // "dark"
 * console.log(theme.isDark);     // true
 * console.log(theme.colors);     // { primary: "#22d3ee", ... }
 * ```
 */
function createThemeStore() {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let currentTheme = $state<ThemeName>(getInitialTheme());

  // Derived state
  const isDark = $derived(currentTheme === 'dark');
  const isLight = $derived(currentTheme === 'light');
  const theme = $derived(THEMES[currentTheme]);
  const colors = $derived(theme.colors);

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Determines initial theme from stored preference or system setting.
   */
  function getInitialTheme(): ThemeName {
    if (typeof window === 'undefined') {
      return 'dark';
    }

    // Check stored preference
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as ThemeName | null;
      if (stored === 'dark' || stored === 'light') {
        return stored;
      }
    } catch {
      // localStorage not available
    }

    // Fall back to system preference
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      return 'light';
    }

    return 'dark';
  }

  /**
   * Applies the current theme to the document.
   */
  function applyCurrentTheme(): void {
    if (typeof document === 'undefined') return;
    applyThemeToElement(document.documentElement, THEMES[currentTheme]);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Sets the active theme.
   *
   * @param name - Theme name to activate
   */
  function setTheme(name: ThemeName): void {
    if (name === currentTheme) return;

    currentTheme = name;
    applyCurrentTheme();

    // Persist preference
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      // localStorage not available
    }
  }

  /**
   * Toggles between dark and light themes.
   */
  function toggle(): void {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  }

  /**
   * Resets to system preference.
   */
  function useSystemPreference(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage not available
    }

    const systemTheme = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';

    currentTheme = systemTheme;
    applyCurrentTheme();
  }

  /**
   * Initializes the theme system.
   *
   * Call this once during app initialization to:
   * - Apply initial theme to document
   * - Set up system preference listener
   *
   * @returns Cleanup function to remove event listeners
   */
  function initialize(): () => void {
    applyCurrentTheme();

    // Listen for system preference changes
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

      const handleChange = (e: MediaQueryListEvent): void => {
        // Only auto-switch if no user preference is stored
        try {
          if (!localStorage.getItem(STORAGE_KEY)) {
            currentTheme = e.matches ? 'dark' : 'light';
            applyCurrentTheme();
          }
        } catch {
          // localStorage not available, always follow system
          currentTheme = e.matches ? 'dark' : 'light';
          applyCurrentTheme();
        }
      };

      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    return () => {};
  }

  // ---------------------------------------------------------------------------
  // Store Object
  // ---------------------------------------------------------------------------

  return {
    // Reactive getters
    get current() { return currentTheme; },
    get isDark() { return isDark; },
    get isLight() { return isLight; },
    get theme() { return theme; },
    get colors() { return colors; },

    // Methods
    setTheme,
    toggle,
    useSystemPreference,
    initialize,
  };
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Global theme store instance.
 *
 * Provides reactive theme state for the entire application.
 * Call `themeStore.initialize()` on app start.
 */
export const themeStore = createThemeStore();

// Export factory for testing
export { createThemeStore };

// Export theme definitions for external use
export { THEMES, DARK_COLORS, LIGHT_COLORS };

// =============================================================================
// CSS Helper Functions
// =============================================================================

/**
 * Gets a CSS custom property value.
 *
 * @param name - Property name (without --color- prefix)
 * @returns CSS var() reference
 *
 * @example
 * cssVar('primary')     // "var(--color-primary)"
 * cssVar('text-muted')  // "var(--color-text-muted)"
 */
export function cssVar(name: string): string {
  const kebabName = name.replace(/([A-Z])/g, '-$1').toLowerCase();
  return `var(--color-${kebabName})`;
}

/**
 * Gets a CSS custom property value with fallback.
 *
 * @param name - Property name (without --color- prefix)
 * @param fallback - Fallback value if property is not defined
 * @returns CSS var() reference with fallback
 *
 * @example
 * cssVarWithFallback('primary', '#22d3ee') // "var(--color-primary, #22d3ee)"
 */
export function cssVarWithFallback(name: string, fallback: string): string {
  const kebabName = name.replace(/([A-Z])/g, '-$1').toLowerCase();
  return `var(--color-${kebabName}, ${fallback})`;
}

/**
 * Generates base CSS that should be included in the global stylesheet.
 *
 * This includes:
 * - CSS custom property definitions
 * - Theme transition styles
 * - Color scheme meta
 *
 * @returns CSS string to include in app.css
 */
export function generateBaseCss(): string {
  return `
/* Theme CSS Custom Properties */
/* Generated by noex-web-dashboard theme system */

:root {
  color-scheme: dark light;
  ${generateCssVariables(DARK_COLORS)}
}

:root[data-theme="light"] {
  color-scheme: light;
  ${generateCssVariables(LIGHT_COLORS)}
}

:root[data-theme="dark"] {
  color-scheme: dark;
  ${generateCssVariables(DARK_COLORS)}
}

/* Theme transition */
:root {
  --theme-transition-duration: 200ms;
}

:root,
:root * {
  transition:
    background-color var(--theme-transition-duration) ease,
    border-color var(--theme-transition-duration) ease,
    color var(--theme-transition-duration) ease;
}

/* Disable transitions for reduced motion preference */
@media (prefers-reduced-motion: reduce) {
  :root,
  :root * {
    transition: none;
  }
}

/* Status indicator classes */
.status-running { color: var(--color-status-running); }
.status-stopping { color: var(--color-status-stopping); }
.status-stopped { color: var(--color-status-stopped); }
.status-warning { color: var(--color-warning); }

.node-connected { color: var(--color-status-connected); }
.node-connecting { color: var(--color-status-connecting); }
.node-disconnected { color: var(--color-status-disconnected); }

/* Semantic background classes */
.bg-success { background-color: var(--color-success-muted); }
.bg-warning { background-color: var(--color-warning-muted); }
.bg-error { background-color: var(--color-error-muted); }
.bg-info { background-color: var(--color-info-muted); }
`;
}
