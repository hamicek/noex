/**
 * Widget type definitions for the dashboard.
 *
 * Defines the contracts that all widgets must implement,
 * enabling consistent lifecycle management and rendering.
 */

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { DashboardTheme } from '../types.js';

/**
 * Base interface for all dashboard widgets.
 *
 * Widgets are self-contained UI components that:
 * - Create and manage their own blessed elements
 * - Update their display based on external data
 * - Handle focus and keyboard events within their bounds
 */
export interface Widget<TData = unknown> {
  /**
   * Creates the blessed element(s) for this widget.
   * Called once during dashboard initialization.
   *
   * @param grid - The blessed-contrib grid to attach to
   * @param position - Grid position specification
   * @returns The created blessed element (for focus management)
   */
  create(
    grid: InstanceType<typeof contrib.grid>,
    position: GridPosition,
  ): blessed.Widgets.BlessedElement;

  /**
   * Updates the widget with new data.
   * Called whenever the underlying data changes.
   *
   * @param data - The data to display
   */
  update(data: TData): void;

  /**
   * Cleans up resources when the widget is destroyed.
   * Called during dashboard shutdown.
   */
  destroy(): void;

  /**
   * Returns the underlying blessed element.
   * Used for focus management and direct manipulation.
   */
  getElement(): blessed.Widgets.BlessedElement | null;
}

/**
 * Grid position specification for widget placement.
 * Uses blessed-contrib's 12x12 grid system.
 */
export interface GridPosition {
  /** Starting row (0-11) */
  readonly row: number;
  /** Starting column (0-11) */
  readonly col: number;
  /** Number of rows to span */
  readonly rowSpan: number;
  /** Number of columns to span */
  readonly colSpan: number;
}

/**
 * Configuration passed to all widgets during creation.
 */
export interface WidgetConfig {
  /** The color theme to use */
  readonly theme: DashboardTheme;
}

/**
 * Abstract base class providing common widget functionality.
 *
 * Implements shared patterns like theme access and element lifecycle,
 * reducing boilerplate in concrete widget implementations.
 */
export abstract class BaseWidget<TData = unknown> implements Widget<TData> {
  protected readonly theme: DashboardTheme;
  protected element: blessed.Widgets.BlessedElement | null = null;

  constructor(config: WidgetConfig) {
    this.theme = config.theme;
  }

  abstract create(
    grid: InstanceType<typeof contrib.grid>,
    position: GridPosition,
  ): blessed.Widgets.BlessedElement;

  abstract update(data: TData): void;

  destroy(): void {
    if (this.element) {
      this.element.destroy();
      this.element = null;
    }
  }

  getElement(): blessed.Widgets.BlessedElement | null {
    return this.element;
  }

  /**
   * Creates standard border style for widgets.
   */
  protected getBorderStyle(): Record<string, unknown> {
    return {
      type: 'line',
      fg: this.theme.primary,
    };
  }

  /**
   * Creates standard label style for widgets.
   */
  protected getLabelStyle(): Record<string, unknown> {
    return {
      fg: this.theme.primary,
    };
  }
}
