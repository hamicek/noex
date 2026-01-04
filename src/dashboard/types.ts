/**
 * Dashboard type definitions.
 *
 * Defines configuration options, themes, and internal types
 * for the TUI dashboard component.
 */

/**
 * Dashboard color theme configuration.
 */
export interface DashboardTheme {
  /** Primary accent color for borders and highlights */
  readonly primary: string;
  /** Secondary color for less prominent elements */
  readonly secondary: string;
  /** Color for successful/running states */
  readonly success: string;
  /** Color for warning states */
  readonly warning: string;
  /** Color for error/stopped states */
  readonly error: string;
  /** Default text color */
  readonly text: string;
  /** Muted text color for secondary information */
  readonly textMuted: string;
  /** Background color */
  readonly background: string;
}

/**
 * Available dashboard layout modes.
 *
 * - 'full': All widgets visible in a comprehensive layout
 * - 'compact': Condensed view with essential widgets
 * - 'minimal': Stripped down view for small terminals
 */
export type DashboardLayout = 'full' | 'compact' | 'minimal';

/**
 * Available color themes.
 */
export type ThemeName = 'dark' | 'light';

/**
 * Dashboard configuration options.
 */
export interface DashboardConfig {
  /**
   * Refresh interval in milliseconds for polling data.
   * @default 500
   */
  readonly refreshInterval: number;

  /**
   * Maximum number of events to keep in the event log.
   * @default 100
   */
  readonly maxEventLogSize: number;

  /**
   * Color theme to use.
   * @default 'dark'
   */
  readonly theme: ThemeName;

  /**
   * Layout mode.
   * @default 'full'
   */
  readonly layout: DashboardLayout;
}

/**
 * Partial configuration options for user customization.
 */
export type DashboardOptions = Partial<DashboardConfig>;

/**
 * Internal event log entry.
 */
export interface EventLogEntry {
  /** Unix timestamp when the event occurred */
  readonly timestamp: number;
  /** Event type/category */
  readonly type: string;
  /** Event message */
  readonly message: string;
  /** Severity level for coloring */
  readonly severity: 'info' | 'success' | 'warning' | 'error';
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: DashboardConfig = {
  refreshInterval: 500,
  maxEventLogSize: 100,
  theme: 'dark',
  layout: 'full',
} as const;

/**
 * Dark theme color palette.
 */
export const DARK_THEME: DashboardTheme = {
  primary: 'cyan',
  secondary: 'blue',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  text: 'white',
  textMuted: 'gray',
  background: 'black',
} as const;

/**
 * Light theme color palette.
 */
export const LIGHT_THEME: DashboardTheme = {
  primary: 'blue',
  secondary: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  text: 'black',
  textMuted: 'gray',
  background: 'white',
} as const;

/**
 * Get theme configuration by name.
 */
export function getTheme(name: ThemeName): DashboardTheme {
  return name === 'dark' ? DARK_THEME : LIGHT_THEME;
}
