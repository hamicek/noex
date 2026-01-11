/**
 * Utility modules for the web dashboard.
 *
 * Re-exports all formatting and theme utilities for convenient importing.
 *
 * @module utils
 */

export {
  // Numeric formatters
  formatNumber,
  formatBytes,

  // Time formatters
  formatUptime,
  formatTime,
  formatDateTime,
  formatDuration,

  // String utilities
  truncate,
  padToWidth,

  // Percentage utilities
  calculatePercent,
  formatPercent,

  // Process formatters
  formatReason,
  formatStatus,

  // Cluster formatters
  formatNodeStatus,
  formatNodeId,

  // Types
  type TerminateReason,
  type ProcessStatus,
  type ClusterNodeStatus,
} from './formatters.js';

export {
  // Theme store
  themeStore,
  createThemeStore,

  // Theme definitions
  THEMES,
  DARK_COLORS,
  LIGHT_COLORS,

  // CSS utilities
  cssVar,
  cssVarWithFallback,
  generateBaseCss,

  // Types
  type ThemeName,
  type ThemeColors,
  type Theme,
} from './theme.js';
