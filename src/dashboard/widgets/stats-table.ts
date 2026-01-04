/**
 * Stats Table Widget for displaying GenServer statistics.
 *
 * Shows a tabular view of all running GenServers with:
 * - ID, Status, Queue Size, Message Count, Uptime, Memory
 * - Row selection and navigation
 * - Visual highlighting for processes with issues
 */

import * as blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { GenServerStats } from '../../core/types.js';
import { formatBytes } from '../../observer/memory-utils.js';
import { BaseWidget, type GridPosition, type WidgetConfig } from './types.js';
import { formatNumber, formatUptime, truncate } from '../utils/formatters.js';

/**
 * Data structure for the stats table widget.
 */
export interface StatsTableData {
  readonly servers: readonly GenServerStats[];
}

/**
 * Column configuration for the table.
 */
interface TableColumn {
  readonly header: string;
  readonly width: number;
  readonly getValue: (stats: GenServerStats) => string;
}

/**
 * Table column definitions with their extraction logic.
 */
const TABLE_COLUMNS: readonly TableColumn[] = [
  {
    header: 'ID',
    width: 24,
    getValue: (s) => truncate(s.id, 22),
  },
  {
    header: 'Status',
    width: 12,
    getValue: (s) => s.status,
  },
  {
    header: 'Queue',
    width: 8,
    getValue: (s) => String(s.queueSize),
  },
  {
    header: 'Messages',
    width: 10,
    getValue: (s) => formatNumber(s.messageCount),
  },
  {
    header: 'Uptime',
    width: 12,
    getValue: (s) => formatUptime(s.uptimeMs),
  },
  {
    header: 'Memory',
    width: 10,
    getValue: (s) => (s.stateMemoryBytes !== undefined ? formatBytes(s.stateMemoryBytes) : '-'),
  },
] as const;

/**
 * Widget that displays GenServer statistics in a table format.
 *
 * Features:
 * - Sortable columns (via column headers)
 * - Row selection with keyboard navigation
 * - Dynamic column widths
 *
 * @example
 * ```
 * | ID          | Status   | Queue | Messages | Uptime   | Memory |
 * |-------------|----------|-------|----------|----------|--------|
 * | counter     | running  | 0     | 1.2K     | 00:05:32 | 64KB   |
 * | cache       | running  | 2     | 890      | 00:05:30 | 128KB  |
 * ```
 */
export class StatsTableWidget extends BaseWidget<StatsTableData> {
  private tableElement: ReturnType<typeof contrib.table> | null = null;

  constructor(config: WidgetConfig) {
    super(config);
  }

  create(
    grid: InstanceType<typeof contrib.grid>,
    position: GridPosition,
  ): blessed.Widgets.BlessedElement {
    this.tableElement = grid.set(
      position.row,
      position.col,
      position.rowSpan,
      position.colSpan,
      contrib.table,
      {
        keys: true,
        fg: this.theme.text,
        selectedFg: this.theme.background,
        selectedBg: this.theme.primary,
        interactive: true,
        label: ' Process Statistics ',
        border: this.getBorderStyle(),
        columnSpacing: 2,
        columnWidth: TABLE_COLUMNS.map((col) => col.width),
      },
    );

    this.element = this.tableElement as unknown as blessed.Widgets.BlessedElement;
    return this.tableElement as unknown as blessed.Widgets.BlessedElement;
  }

  update(data: StatsTableData): void {
    if (!this.tableElement) return;

    const { servers } = data;
    const headers = TABLE_COLUMNS.map((col) => col.header);
    const rows = this.buildRows(servers);

    this.tableElement.setData({
      headers,
      data: rows,
    });
  }

  /**
   * Builds table rows from server statistics.
   */
  private buildRows(servers: readonly GenServerStats[]): string[][] {
    if (servers.length === 0) {
      return [this.getEmptyRow()];
    }

    return servers.map((server) => this.buildRow(server));
  }

  /**
   * Builds a single table row from server stats.
   */
  private buildRow(stats: GenServerStats): string[] {
    return TABLE_COLUMNS.map((col) => col.getValue(stats));
  }

  /**
   * Returns a placeholder row for empty state.
   */
  private getEmptyRow(): string[] {
    return ['No processes', '-', '-', '-', '-', '-'];
  }

  /**
   * Gets the currently selected server ID, if any.
   * Note: This uses internal blessed-contrib APIs that may change.
   */
  getSelectedId(): string | null {
    if (!this.tableElement) return null;

    // blessed-contrib table stores rows in a nested structure
    const tableAny = this.tableElement as unknown as {
      rows?: {
        selected?: number;
        items?: string[][];
      };
    };

    const rows = tableAny.rows;
    if (!rows || rows.selected === undefined || rows.selected < 0) return null;
    if (!rows.items) return null;

    const selectedRow = rows.items[rows.selected];
    if (!selectedRow) return null;

    const firstCell = selectedRow[0];
    if (firstCell === undefined || firstCell === 'No processes') return null;
    return firstCell;
  }
}
