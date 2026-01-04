/**
 * Memory Gauge Widget for displaying heap memory usage.
 *
 * Shows a visual gauge indicating current memory usage with:
 * - Color-coded thresholds (green/yellow/red)
 * - Percentage and absolute values in label
 */

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { MemoryStats } from '../../core/types.js';
import { formatBytes } from '../../observer/memory-utils.js';
import { BaseWidget, type GridPosition, type WidgetConfig } from './types.js';
import { calculatePercent } from '../utils/formatters.js';

/**
 * Data structure for the memory gauge widget.
 */
export interface MemoryGaugeData {
  readonly memoryStats: MemoryStats;
}

/**
 * Memory usage threshold levels for color coding.
 */
const THRESHOLDS = {
  /** Below this percentage: green (healthy) */
  HEALTHY: 60,
  /** Below this percentage: yellow (warning) */
  WARNING: 80,
  /** Above WARNING: red (critical) */
} as const;

/**
 * Widget that displays heap memory usage as a visual gauge.
 *
 * The gauge changes color based on usage level:
 * - Green (<60%): Healthy memory usage
 * - Yellow (60-80%): Elevated usage, monitor closely
 * - Red (>80%): Critical, may need attention
 *
 * @example
 * ```
 * \u250C\u2500 Heap Memory (128MB / 512MB) \u2500\u2510
 * \u2502 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 25%  \u2502
 * \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
 * ```
 */
export class MemoryGaugeWidget extends BaseWidget<MemoryGaugeData> {
  private gaugeElement: ReturnType<typeof contrib.gauge> | null = null;

  constructor(config: WidgetConfig) {
    super(config);
  }

  create(
    grid: InstanceType<typeof contrib.grid>,
    position: GridPosition,
  ): blessed.Widgets.BlessedElement {
    this.gaugeElement = grid.set(
      position.row,
      position.col,
      position.rowSpan,
      position.colSpan,
      contrib.gauge,
      {
        label: ' Heap Memory ',
        stroke: this.theme.success,
        fill: this.theme.background,
        border: this.getBorderStyle(),
      },
    );

    this.element = this.gaugeElement as unknown as blessed.Widgets.BlessedElement;
    return this.gaugeElement as unknown as blessed.Widgets.BlessedElement;
  }

  update(data: MemoryGaugeData): void {
    if (!this.gaugeElement) return;

    const { memoryStats } = data;
    const percent = calculatePercent(memoryStats.heapUsed, memoryStats.heapTotal);

    this.updateColor(percent);
    this.gaugeElement.setPercent(percent);
    this.gaugeElement.setLabel(this.buildLabel(memoryStats));
  }

  /**
   * Updates the gauge color based on usage percentage.
   */
  private updateColor(percent: number): void {
    if (!this.gaugeElement) return;

    const color = this.getColorForPercent(percent);

    // Access options directly (blessed-contrib types don't expose setOptions)
    (this.gaugeElement.options as { stroke?: string }).stroke = color;
  }

  /**
   * Gets the appropriate color for a given percentage.
   */
  private getColorForPercent(percent: number): string {
    if (percent >= THRESHOLDS.WARNING) {
      return this.theme.error;
    }
    if (percent >= THRESHOLDS.HEALTHY) {
      return this.theme.warning;
    }
    return this.theme.success;
  }

  /**
   * Builds the label showing memory values.
   */
  private buildLabel(stats: MemoryStats): string {
    const used = formatBytes(stats.heapUsed);
    const total = formatBytes(stats.heapTotal);
    return ` Heap Memory (${used} / ${total}) `;
  }
}
