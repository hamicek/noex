/**
 * Formatting utilities for dashboard display.
 *
 * Provides consistent formatting functions for numbers, bytes, time,
 * and other values displayed in the dashboard widgets.
 */

/**
 * Formats a number with K/M/B suffixes for readability.
 *
 * @param value - The number to format
 * @param precision - Decimal places for suffixed values (default: 1)
 * @returns Formatted string with appropriate suffix
 *
 * @example
 * formatNumber(1234)      // "1.2K"
 * formatNumber(1234567)   // "1.2M"
 * formatNumber(42)        // "42"
 */
export function formatNumber(value: number, precision = 1): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(precision)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(precision)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(precision)}K`;
  }
  return String(value);
}

/**
 * Formats milliseconds as HH:MM:SS uptime string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted time string
 *
 * @example
 * formatUptime(3661000)  // "01:01:01"
 * formatUptime(61000)    // "00:01:01"
 */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

/**
 * Formats a timestamp as HH:MM:SS time string.
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted time string
 *
 * @example
 * formatTime(Date.now())  // "14:32:45"
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Truncates a string to a maximum length with ellipsis.
 *
 * @param str - String to truncate
 * @param maxLength - Maximum length including ellipsis
 * @returns Truncated string or original if shorter
 *
 * @example
 * truncate("hello world", 8)  // "hello\u2026"
 * truncate("hello", 8)        // "hello"
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 1) + '\u2026';
}

/**
 * Calculates percentage with bounds checking.
 *
 * @param value - Current value
 * @param total - Maximum value
 * @returns Percentage as integer (0-100)
 */
export function calculatePercent(value: number, total: number): number {
  if (total <= 0) return 0;
  const percent = Math.round((value / total) * 100);
  return Math.max(0, Math.min(100, percent));
}

/**
 * Box-drawing characters for tree visualization.
 */
export const TreeChars = {
  /** Vertical line: \u2502 */
  VERTICAL: '\u2502',
  /** T-junction: \u251C */
  BRANCH: '\u251C',
  /** L-corner: \u2514 */
  LAST_BRANCH: '\u2514',
  /** Horizontal line: \u2500 */
  HORIZONTAL: '\u2500',
  /** Filled circle: \u25CF */
  FILLED_CIRCLE: '\u25CF',
  /** Hollow circle: \u25CB */
  HOLLOW_CIRCLE: '\u25CB',
  /** Down arrow: \u25BC */
  DOWN_ARROW: '\u25BC',
} as const;

/**
 * Formats a terminate reason for display.
 *
 * @param reason - The termination reason
 * @returns Human-readable reason string
 */
export function formatReason(
  reason: 'normal' | 'shutdown' | { error: Error },
): string {
  if (reason === 'normal') return 'normal';
  if (reason === 'shutdown') return 'shutdown';
  return `error: ${reason.error.message}`;
}
