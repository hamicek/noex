/**
 * Formatting utilities for the web dashboard.
 *
 * Provides pure, stateless formatting functions for numbers, bytes, time,
 * and other values displayed in dashboard components.
 *
 * @module utils/formatters
 */

// =============================================================================
// Numeric Formatters
// =============================================================================

/**
 * Size magnitude thresholds for SI prefix formatting.
 */
const MAGNITUDE = {
  BILLION: 1_000_000_000,
  MILLION: 1_000_000,
  THOUSAND: 1_000,
} as const;

/**
 * Formats a number with K/M/B suffixes for compact display.
 *
 * Uses SI prefixes for readability in space-constrained UI elements.
 *
 * @param value - The number to format
 * @param precision - Decimal places for suffixed values (default: 1)
 * @returns Formatted string with appropriate suffix
 *
 * @example
 * formatNumber(42)         // "42"
 * formatNumber(1234)       // "1.2K"
 * formatNumber(1234567)    // "1.2M"
 * formatNumber(1234567890) // "1.2B"
 */
export function formatNumber(value: number, precision = 1): string {
  if (value >= MAGNITUDE.BILLION) {
    return `${(value / MAGNITUDE.BILLION).toFixed(precision)}B`;
  }
  if (value >= MAGNITUDE.MILLION) {
    return `${(value / MAGNITUDE.MILLION).toFixed(precision)}M`;
  }
  if (value >= MAGNITUDE.THOUSAND) {
    return `${(value / MAGNITUDE.THOUSAND).toFixed(precision)}K`;
  }
  return String(value);
}

/**
 * Byte size thresholds for binary prefix formatting.
 */
const BYTE_MAGNITUDE = {
  GB: 1024 * 1024 * 1024,
  MB: 1024 * 1024,
  KB: 1024,
} as const;

/**
 * Formats bytes with appropriate binary prefix (KB, MB, GB).
 *
 * Uses binary prefixes (1024-based) for accurate memory representation.
 *
 * @param bytes - Number of bytes
 * @param precision - Decimal places (default: 1)
 * @returns Formatted string with unit suffix
 *
 * @example
 * formatBytes(512)        // "512 B"
 * formatBytes(1536)       // "1.5 KB"
 * formatBytes(1572864)    // "1.5 MB"
 * formatBytes(1610612736) // "1.5 GB"
 */
export function formatBytes(bytes: number, precision = 1): string {
  if (bytes >= BYTE_MAGNITUDE.GB) {
    return `${(bytes / BYTE_MAGNITUDE.GB).toFixed(precision)} GB`;
  }
  if (bytes >= BYTE_MAGNITUDE.MB) {
    return `${(bytes / BYTE_MAGNITUDE.MB).toFixed(precision)} MB`;
  }
  if (bytes >= BYTE_MAGNITUDE.KB) {
    return `${(bytes / BYTE_MAGNITUDE.KB).toFixed(precision)} KB`;
  }
  return `${bytes} B`;
}

// =============================================================================
// Time Formatters
// =============================================================================

/**
 * Time constants in milliseconds.
 */
const TIME_MS = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
} as const;

/**
 * Formats milliseconds as HH:MM:SS uptime string.
 *
 * Designed for displaying process uptime in a consistent format.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted time string (HH:MM:SS)
 *
 * @example
 * formatUptime(0)       // "00:00:00"
 * formatUptime(61000)   // "00:01:01"
 * formatUptime(3661000) // "01:01:01"
 */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / TIME_MS.SECOND);
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
 * Formats a timestamp as localized HH:MM:SS time string.
 *
 * Uses 24-hour format for consistency across the dashboard.
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted time string
 *
 * @example
 * formatTime(Date.now()) // "14:32:45"
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Formats a timestamp as localized date-time string.
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted date-time string
 *
 * @example
 * formatDateTime(Date.now()) // "2024-01-15 14:32:45"
 */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const time = formatTime(timestamp);
  return `${year}-${month}-${day} ${time}`;
}

/**
 * Formats duration as human-readable relative time.
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable string
 *
 * @example
 * formatDuration(500)     // "500ms"
 * formatDuration(5000)    // "5s"
 * formatDuration(65000)   // "1m 5s"
 * formatDuration(3665000) // "1h 1m"
 */
export function formatDuration(ms: number): string {
  if (ms < TIME_MS.SECOND) {
    return `${ms}ms`;
  }

  const totalSeconds = Math.floor(ms / TIME_MS.SECOND);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

// =============================================================================
// String Utilities
// =============================================================================

/**
 * Truncates a string to a maximum length with ellipsis.
 *
 * Preserves readability while fitting text into constrained spaces.
 *
 * @param str - String to truncate
 * @param maxLength - Maximum length including ellipsis
 * @returns Truncated string with ellipsis or original if shorter
 *
 * @example
 * truncate("hello world", 8) // "hello w\u2026"
 * truncate("hello", 8)       // "hello"
 * truncate("", 5)            // ""
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 1) + '\u2026';
}

/**
 * Pads a string to a fixed width, truncating if necessary.
 *
 * Useful for creating fixed-width columns in tables.
 *
 * @param str - String to pad
 * @param width - Desired width
 * @param align - Alignment ('left' | 'right' | 'center')
 * @returns Padded/truncated string
 *
 * @example
 * padToWidth("test", 10, 'left')   // "test      "
 * padToWidth("test", 10, 'right')  // "      test"
 * padToWidth("test", 10, 'center') // "   test   "
 */
export function padToWidth(
  str: string,
  width: number,
  align: 'left' | 'right' | 'center' = 'left',
): string {
  if (str.length > width) {
    return truncate(str, width);
  }

  const padding = width - str.length;

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + str;
    case 'center': {
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      return ' '.repeat(leftPad) + str + ' '.repeat(rightPad);
    }
    default:
      return str + ' '.repeat(padding);
  }
}

// =============================================================================
// Percentage Calculations
// =============================================================================

/**
 * Calculates percentage with bounds checking.
 *
 * Safe for UI progress bars and gauges that require 0-100 range.
 *
 * @param value - Current value
 * @param total - Maximum value
 * @returns Percentage as integer clamped to 0-100
 *
 * @example
 * calculatePercent(50, 100)   // 50
 * calculatePercent(150, 100)  // 100
 * calculatePercent(-10, 100)  // 0
 * calculatePercent(50, 0)     // 0
 */
export function calculatePercent(value: number, total: number): number {
  if (total <= 0) return 0;
  const percent = Math.round((value / total) * 100);
  return Math.max(0, Math.min(100, percent));
}

/**
 * Formats a percentage value for display.
 *
 * @param value - Current value
 * @param total - Maximum value
 * @param precision - Decimal places (default: 0)
 * @returns Formatted percentage string with % suffix
 *
 * @example
 * formatPercent(33, 100)    // "33%"
 * formatPercent(1, 3)       // "33%"
 * formatPercent(1, 3, 1)    // "33.3%"
 */
export function formatPercent(value: number, total: number, precision = 0): string {
  if (total <= 0) return '0%';
  const percent = (value / total) * 100;
  return `${percent.toFixed(precision)}%`;
}

// =============================================================================
// Process Status Formatters
// =============================================================================

/**
 * Termination reason type from noex.
 */
export type TerminateReason = 'normal' | 'shutdown' | { error: Error };

/**
 * Formats a terminate reason for human-readable display.
 *
 * @param reason - The termination reason
 * @returns Human-readable reason string
 *
 * @example
 * formatReason('normal')                    // "normal"
 * formatReason('shutdown')                  // "shutdown"
 * formatReason({ error: new Error("...") }) // "error: ..."
 */
export function formatReason(reason: TerminateReason): string {
  if (reason === 'normal') return 'normal';
  if (reason === 'shutdown') return 'shutdown';
  return `error: ${reason.error.message}`;
}

/**
 * Process status types from noex.
 */
export type ProcessStatus = 'running' | 'stopping' | 'stopped';

/**
 * Formats a process status for display with appropriate styling class.
 *
 * @param status - Process status
 * @returns Object with display text and CSS class
 *
 * @example
 * formatStatus('running')  // { text: "Running", className: "status-running" }
 * formatStatus('stopping') // { text: "Stopping", className: "status-warning" }
 * formatStatus('stopped')  // { text: "Stopped", className: "status-stopped" }
 */
export function formatStatus(status: ProcessStatus): { text: string; className: string } {
  switch (status) {
    case 'running':
      return { text: 'Running', className: 'status-running' };
    case 'stopping':
      return { text: 'Stopping', className: 'status-warning' };
    case 'stopped':
      return { text: 'Stopped', className: 'status-stopped' };
  }
}

// =============================================================================
// Cluster Formatters
// =============================================================================

/**
 * Cluster node status from noex.
 */
export type ClusterNodeStatus = 'connected' | 'connecting' | 'disconnected';

/**
 * Formats a cluster node status for display.
 *
 * @param status - Node connection status
 * @returns Object with display text and CSS class
 *
 * @example
 * formatNodeStatus('connected')    // { text: "Connected", className: "node-connected" }
 * formatNodeStatus('connecting')   // { text: "Connecting", className: "node-connecting" }
 * formatNodeStatus('disconnected') // { text: "Disconnected", className: "node-disconnected" }
 */
export function formatNodeStatus(status: ClusterNodeStatus): { text: string; className: string } {
  switch (status) {
    case 'connected':
      return { text: 'Connected', className: 'node-connected' };
    case 'connecting':
      return { text: 'Connecting', className: 'node-connecting' };
    case 'disconnected':
      return { text: 'Disconnected', className: 'node-disconnected' };
  }
}

/**
 * Formats a node ID for compact display.
 *
 * Extracts the meaningful part of node identifiers.
 *
 * @param nodeId - Full node identifier
 * @param maxLength - Maximum length (default: 20)
 * @returns Compact node identifier
 *
 * @example
 * formatNodeId("node-abc123@192.168.1.100:4369") // "abc123@192.168.1.100"
 * formatNodeId("worker-1")                       // "worker-1"
 */
export function formatNodeId(nodeId: string, maxLength = 20): string {
  // Remove common prefixes
  let compact = nodeId.replace(/^node-/, '').replace(/^noex@/, '');

  // Truncate if still too long
  return truncate(compact, maxLength);
}
