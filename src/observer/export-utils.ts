/**
 * Export utilities for noex Observer.
 *
 * Provides functions for exporting system snapshots and metrics history
 * to JSON and CSV formats for analysis, reporting, and archival purposes.
 */

import type { ObserverSnapshot } from './types.js';
import type { MemoryStats, GenServerStats, SupervisorStats } from '../core/types.js';

/**
 * Time-series data point for metrics history.
 */
export interface MetricsDataPoint {
  readonly timestamp: number;
  readonly value: number;
}

/**
 * Per-process metrics history.
 */
export interface ProcessMetricsHistory {
  readonly queueSize: readonly MetricsDataPoint[];
  readonly messageCount: readonly MetricsDataPoint[];
}

/**
 * Complete export data structure containing snapshot and optional metrics history.
 * This is the canonical format for full system state export.
 */
export interface ExportData {
  /** Current system snapshot */
  readonly snapshot: ObserverSnapshot;
  /** Optional historical metrics data */
  readonly metricsHistory?: MetricsHistory;
  /** Unix timestamp when the export was created */
  readonly exportedAt: number;
  /** Export format version for future compatibility */
  readonly version: '1.0';
}

/**
 * Historical metrics data for time-series analysis.
 */
export interface MetricsHistory {
  /** Message throughput over time (messages per second) */
  readonly throughput: readonly MetricsDataPoint[];
  /** Active process count over time */
  readonly processCount: readonly MetricsDataPoint[];
  /** Restart rate over time (restarts per second) */
  readonly restartRate: readonly MetricsDataPoint[];
  /** Memory statistics over time */
  readonly memory: readonly MemoryStats[];
  /** Per-process metrics keyed by process ID */
  readonly perProcess: Readonly<Record<string, ProcessMetricsHistory>>;
}

/**
 * CSV export result containing multiple files for different data types.
 */
export interface CsvExportResult {
  /** Summary statistics CSV */
  readonly summary: string;
  /** GenServer details CSV */
  readonly servers: string;
  /** Supervisor details CSV */
  readonly supervisors: string;
  /** Optional metrics history CSV (if history provided) */
  readonly metricsHistory?: string;
}

/**
 * Escapes a value for safe CSV inclusion.
 * Handles strings with commas, quotes, and newlines per RFC 4180.
 */
function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const str = String(value);

  // Check if escaping is needed
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    // Escape quotes by doubling them and wrap in quotes
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Converts an array of objects to CSV format.
 * Automatically extracts headers from the first object's keys.
 */
function objectsToCsv<T extends Record<string, unknown>>(
  objects: readonly T[],
  headers?: readonly string[],
): string {
  if (objects.length === 0) {
    return headers ? headers.join(',') : '';
  }

  const firstObject = objects[0]!;
  const keys = headers ?? Object.keys(firstObject);
  const headerRow = keys.join(',');

  const dataRows = objects.map((obj) =>
    keys.map((key) => escapeCsvValue(obj[key])).join(','),
  );

  return [headerRow, ...dataRows].join('\n');
}

/**
 * Formats a Unix timestamp as ISO 8601 string for CSV export.
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Exports system data to JSON format.
 *
 * Produces a well-structured JSON document containing the current snapshot
 * and optional metrics history. The output is suitable for:
 * - Importing into analysis tools
 * - Archival and auditing
 * - Sharing system state for debugging
 *
 * @param data - Export data containing snapshot and optional history
 * @returns Formatted JSON string with 2-space indentation
 *
 * @example
 * ```typescript
 * const data = Observer.prepareExportData();
 * const json = exportToJson(data);
 * await fs.writeFile('export.json', json);
 * ```
 */
export function exportToJson(data: ExportData): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Exports system data to CSV format.
 *
 * Generates multiple CSV files for different data types:
 * - summary.csv: Aggregate system statistics
 * - servers.csv: Per-GenServer statistics
 * - supervisors.csv: Per-Supervisor statistics
 * - metricsHistory.csv: Time-series metrics (if history provided)
 *
 * @param data - Export data containing snapshot and optional history
 * @returns Object containing CSV strings for each data type
 *
 * @example
 * ```typescript
 * const data = Observer.prepareExportData();
 * const csvs = exportToCsv(data);
 * await fs.writeFile('servers.csv', csvs.servers);
 * ```
 */
export function exportToCsv(data: ExportData): CsvExportResult {
  const { snapshot } = data;

  // Summary CSV - single row with aggregate stats
  const summaryData = [
    {
      timestamp: formatTimestamp(snapshot.timestamp),
      processCount: snapshot.processCount,
      serverCount: snapshot.servers.length,
      supervisorCount: snapshot.supervisors.length,
      totalMessages: snapshot.totalMessages,
      totalRestarts: snapshot.totalRestarts,
      heapUsedBytes: snapshot.memoryStats.heapUsed,
      heapTotalBytes: snapshot.memoryStats.heapTotal,
      rssBytes: snapshot.memoryStats.rss,
      externalBytes: snapshot.memoryStats.external,
    },
  ];

  const summaryHeaders = [
    'timestamp',
    'processCount',
    'serverCount',
    'supervisorCount',
    'totalMessages',
    'totalRestarts',
    'heapUsedBytes',
    'heapTotalBytes',
    'rssBytes',
    'externalBytes',
  ] as const;

  // Servers CSV - one row per GenServer
  const serversData = snapshot.servers.map((server) => ({
    id: server.id,
    status: server.status,
    queueSize: server.queueSize,
    messageCount: server.messageCount,
    startedAt: formatTimestamp(server.startedAt),
    uptimeMs: server.uptimeMs,
    stateMemoryBytes: server.stateMemoryBytes ?? '',
  }));

  const serversHeaders = [
    'id',
    'status',
    'queueSize',
    'messageCount',
    'startedAt',
    'uptimeMs',
    'stateMemoryBytes',
  ] as const;

  // Supervisors CSV - one row per Supervisor
  const supervisorsData = snapshot.supervisors.map((supervisor) => ({
    id: supervisor.id,
    strategy: supervisor.strategy,
    childCount: supervisor.childCount,
    totalRestarts: supervisor.totalRestarts,
    startedAt: formatTimestamp(supervisor.startedAt),
    uptimeMs: supervisor.uptimeMs,
  }));

  const supervisorsHeaders = [
    'id',
    'strategy',
    'childCount',
    'totalRestarts',
    'startedAt',
    'uptimeMs',
  ] as const;

  const result: CsvExportResult = {
    summary: objectsToCsv(summaryData, summaryHeaders),
    servers: objectsToCsv(serversData, serversHeaders),
    supervisors: objectsToCsv(supervisorsData, supervisorsHeaders),
  };

  // Metrics history CSV (if available)
  if (data.metricsHistory) {
    const historyData = buildMetricsHistoryCsv(data.metricsHistory);
    return { ...result, metricsHistory: historyData };
  }

  return result;
}

/**
 * Builds a combined metrics history CSV from time-series data.
 * Aligns data points by timestamp for easier analysis.
 */
function buildMetricsHistoryCsv(history: MetricsHistory): string {
  // Collect all unique timestamps
  const timestampSet = new Set<number>();

  for (const point of history.throughput) {
    timestampSet.add(point.timestamp);
  }
  for (const point of history.processCount) {
    timestampSet.add(point.timestamp);
  }
  for (const point of history.restartRate) {
    timestampSet.add(point.timestamp);
  }
  for (const memStats of history.memory) {
    timestampSet.add(memStats.timestamp);
  }

  const timestamps = Array.from(timestampSet).sort((a, b) => a - b);

  if (timestamps.length === 0) {
    return 'timestamp,throughput,processCount,restartRate,heapUsedBytes';
  }

  // Create lookup maps for O(1) access
  const throughputMap = new Map(history.throughput.map((p) => [p.timestamp, p.value]));
  const processCountMap = new Map(history.processCount.map((p) => [p.timestamp, p.value]));
  const restartRateMap = new Map(history.restartRate.map((p) => [p.timestamp, p.value]));
  const memoryMap = new Map(history.memory.map((m) => [m.timestamp, m]));

  const headers = ['timestamp', 'throughput', 'processCount', 'restartRate', 'heapUsedBytes'];
  const rows = timestamps.map((ts) => {
    const mem = memoryMap.get(ts);
    return [
      formatTimestamp(ts),
      throughputMap.get(ts) ?? '',
      processCountMap.get(ts) ?? '',
      restartRateMap.get(ts) ?? '',
      mem?.heapUsed ?? '',
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Creates export data from a snapshot without metrics history.
 * Convenience function for simple exports.
 *
 * @param snapshot - Current system snapshot
 * @returns Export data structure ready for JSON/CSV export
 */
export function createExportData(snapshot: ObserverSnapshot): ExportData {
  return {
    snapshot,
    exportedAt: Date.now(),
    version: '1.0',
  };
}

/**
 * Creates export data with metrics history.
 *
 * @param snapshot - Current system snapshot
 * @param metricsHistory - Historical metrics data
 * @returns Export data structure with history
 */
export function createExportDataWithHistory(
  snapshot: ObserverSnapshot,
  metricsHistory: MetricsHistory,
): ExportData {
  return {
    snapshot,
    metricsHistory,
    exportedAt: Date.now(),
    version: '1.0',
  };
}
