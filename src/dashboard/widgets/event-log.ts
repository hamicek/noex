/**
 * Event Log Widget for displaying recent system events.
 *
 * Shows a scrollable log of events with:
 * - Timestamp and message
 * - Color-coded severity levels
 * - Automatic scrolling to newest entries
 */

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { EventLogEntry, DashboardTheme } from '../types.js';
import { BaseWidget, type GridPosition, type WidgetConfig } from './types.js';
import { formatTime } from '../utils/formatters.js';

/**
 * Event severity levels.
 */
export type EventSeverity = 'info' | 'success' | 'warning' | 'error';

/**
 * Event to be logged in the widget.
 */
export interface LogEvent {
  readonly message: string;
  readonly severity: EventSeverity;
  readonly timestamp?: number;
}

/**
 * Widget configuration including buffer size.
 */
export interface EventLogConfig extends WidgetConfig {
  /** Maximum number of log entries to keep */
  readonly maxEntries: number;
}

/**
 * Widget that displays a scrollable log of system events.
 *
 * Features:
 * - Color-coded severity (info, success, warning, error)
 * - Automatic scroll to bottom on new entries
 * - Configurable buffer size
 *
 * @example
 * ```
 * 12:34:56 GenServer started: counter
 * 12:34:58 stats_update
 * 12:35:01 alert: high_queue in worker
 * ```
 */
export class EventLogWidget extends BaseWidget<void> {
  private logElement: ReturnType<typeof contrib.log> | null = null;
  private readonly maxEntries: number;
  private readonly entries: EventLogEntry[] = [];

  constructor(config: EventLogConfig) {
    super(config);
    this.maxEntries = config.maxEntries;
  }

  create(
    grid: InstanceType<typeof contrib.grid>,
    position: GridPosition,
  ): blessed.Widgets.BlessedElement {
    this.logElement = grid.set(
      position.row,
      position.col,
      position.rowSpan,
      position.colSpan,
      contrib.log,
      {
        label: ' Event Log ',
        tags: true,
        fg: this.theme.text,
        selectedFg: this.theme.background,
        border: this.getBorderStyle(),
        bufferLength: this.maxEntries,
      },
    );

    this.element = this.logElement as unknown as blessed.Widgets.BlessedElement;
    return this.logElement as unknown as blessed.Widgets.BlessedElement;
  }

  /**
   * Not used for event log - use log() method instead.
   */
  update(_data: void): void {
    // Event log uses log() method for adding entries
  }

  /**
   * Adds a new event to the log.
   */
  log(event: LogEvent): void {
    const timestamp = event.timestamp ?? Date.now();
    const entry = this.createEntry(event, timestamp);

    this.entries.push(entry);
    this.pruneEntries();
    this.appendToWidget(entry);
  }

  /**
   * Returns all current log entries.
   */
  getEntries(): readonly EventLogEntry[] {
    return this.entries;
  }

  /**
   * Clears all log entries.
   */
  clear(): void {
    this.entries.length = 0;
    // blessed-contrib log widget doesn't have a clear method,
    // so we recreate by logging empty content
  }

  /**
   * Creates a log entry from an event.
   */
  private createEntry(event: LogEvent, timestamp: number): EventLogEntry {
    return {
      timestamp,
      type: event.severity,
      message: event.message,
      severity: event.severity,
    };
  }

  /**
   * Removes oldest entries if buffer is full.
   */
  private pruneEntries(): void {
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * Appends an entry to the widget display.
   */
  private appendToWidget(entry: EventLogEntry): void {
    if (!this.logElement) return;

    const timeStr = formatTime(entry.timestamp);
    const color = this.getSeverityColor(entry.severity);

    const formattedLine =
      `{${this.theme.textMuted}-fg}${timeStr}{/${this.theme.textMuted}-fg} ` +
      `{${color}-fg}${entry.message}{/${color}-fg}`;

    this.logElement.log(formattedLine);
  }

  /**
   * Gets the color for a severity level.
   */
  private getSeverityColor(severity: EventSeverity): string {
    switch (severity) {
      case 'success':
        return this.theme.success;
      case 'warning':
        return this.theme.warning;
      case 'error':
        return this.theme.error;
      case 'info':
      default:
        return this.theme.text;
    }
  }
}

/**
 * Factory function for creating EventLogWidget with simplified config.
 */
export function createEventLogWidget(
  theme: DashboardTheme,
  maxEntries: number,
): EventLogWidget {
  return new EventLogWidget({ theme, maxEntries });
}
