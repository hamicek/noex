import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Extract ChartRenderer from the HTML file and test its logic.
 * Uses mocked canvas context since we're running in Node.js.
 */
describe('ChartRenderer', () => {
  let ChartRenderer: typeof globalThis.ChartRenderer;

  beforeEach(() => {
    // Read and extract JS from HTML
    const htmlPath = join(__dirname, '../../examples/web-server/public/observer/index.html');
    const html = readFileSync(htmlPath, 'utf-8');
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

    if (!scriptMatch) {
      throw new Error('Could not extract script from HTML');
    }

    // Create mock DOM elements for export functionality
    const mockExportDropdown = {
      classList: { toggle: vi.fn(), remove: vi.fn() },
      contains: vi.fn(() => false),
    };
    const mockExportBtn = {
      addEventListener: vi.fn(),
    };

    // Mock elements for stop process modal
    const mockStopModal = {
      classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
      addEventListener: vi.fn(),
    };
    const mockStopModalProcessName = { textContent: '' };
    const mockStopModalWarning = { style: { display: 'none' } };
    const mockStopReason = {
      value: '',
      focus: vi.fn(),
      addEventListener: vi.fn(),
    };
    const mockStopModalCancel = { addEventListener: vi.fn() };
    const mockStopModalConfirm = {
      addEventListener: vi.fn(),
      disabled: false,
      innerHTML: '',
    };
    const mockToastContainer = { appendChild: vi.fn() };

    // Mock elements for alert banner
    const mockAlertBanner = {
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    const mockAlertBannerText = { textContent: '' };
    const mockAlertBannerCount = { textContent: '' };
    const mockAlertBannerDismiss = { addEventListener: vi.fn() };

    // Mock elements for alert history panel
    const mockAlertHistoryPanel = {
      classList: { add: vi.fn(), toggle: vi.fn() },
    };
    const mockAlertHistoryHeader = { addEventListener: vi.fn() };
    const mockAlertHistoryContent = { innerHTML: '' };
    const mockAlertActiveCount = { textContent: '', style: { display: 'none' } };

    // Create a sandbox to execute the script and extract ChartRenderer
    const sandbox = {
      window: { devicePixelRatio: 2 },
      document: {
        getElementById: vi.fn((id: string) => {
          if (id === 'exportDropdown') return mockExportDropdown;
          if (id === 'exportBtn') return mockExportBtn;
          if (id === 'stopModal') return mockStopModal;
          if (id === 'stopModalProcessName') return mockStopModalProcessName;
          if (id === 'stopModalWarning') return mockStopModalWarning;
          if (id === 'stopReason') return mockStopReason;
          if (id === 'stopModalCancel') return mockStopModalCancel;
          if (id === 'stopModalConfirm') return mockStopModalConfirm;
          if (id === 'toastContainer') return mockToastContainer;
          // Alert banner elements
          if (id === 'alertBanner') return mockAlertBanner;
          if (id === 'alertBannerText') return mockAlertBannerText;
          if (id === 'alertBannerCount') return mockAlertBannerCount;
          if (id === 'alertBannerDismiss') return mockAlertBannerDismiss;
          // Alert history panel elements
          if (id === 'alertHistoryPanel') return mockAlertHistoryPanel;
          if (id === 'alertHistoryHeader') return mockAlertHistoryHeader;
          if (id === 'alertHistoryContent') return mockAlertHistoryContent;
          if (id === 'alertActiveCount') return mockAlertActiveCount;
          return null;
        }),
        addEventListener: vi.fn(),
        querySelectorAll: vi.fn(() => []),
        createElement: vi.fn(() => ({
          className: '',
          innerHTML: '',
          style: {},
          remove: vi.fn(),
        })),
      },
      Date: { now: () => Date.now() },
      Map: Map,
      Set: Set,
      Array: Array,
      Math: Math,
      console: console,
      setTimeout: setTimeout,
      requestAnimationFrame: vi.fn(),
      location: { protocol: 'http:', host: 'localhost:3000' },
      WebSocket: vi.fn(),
      fetch: vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })),
      encodeURIComponent,
    };

    // Execute script in sandbox context
    const script = scriptMatch[1];
    const fn = new Function(
      ...Object.keys(sandbox),
      `${script}; return { ChartRenderer, MetricsHistory, metricsStore };`
    );

    const result = fn(...Object.values(sandbox));
    ChartRenderer = result.ChartRenderer;
  });

  describe('colors', () => {
    it('should have correct color definitions', () => {
      expect(ChartRenderer.colors.throughput).toBe('#22c55e');
      expect(ChartRenderer.colors.processCount).toBe('#3b82f6');
      expect(ChartRenderer.colors.restarts).toBe('#eab308');
      expect(ChartRenderer.colors.queueSize).toBe('#a855f7');
      expect(ChartRenderer.colors.memory).toBe('#06b6d4');
    });
  });

  describe('config', () => {
    it('should have proper configuration values', () => {
      expect(ChartRenderer.config.lineWidth).toBe(2);
      expect(ChartRenderer.config.gridLineCount).toBe(4);
      expect(ChartRenderer.config.fontSize).toBe(10);
      expect(ChartRenderer.config.padding).toEqual({
        top: 10,
        right: 12,
        bottom: 20,
        left: 45,
      });
    });
  });

  describe('_formatValue', () => {
    it('should format millions with M suffix', () => {
      expect(ChartRenderer._formatValue(1500000)).toBe('1.5M');
      expect(ChartRenderer._formatValue(2000000)).toBe('2.0M');
    });

    it('should format thousands with K suffix', () => {
      expect(ChartRenderer._formatValue(1500)).toBe('1.5K');
      expect(ChartRenderer._formatValue(10000)).toBe('10.0K');
    });

    it('should format hundreds as integers', () => {
      expect(ChartRenderer._formatValue(150)).toBe('150');
      expect(ChartRenderer._formatValue(999)).toBe('999');
    });

    it('should format tens with one decimal', () => {
      expect(ChartRenderer._formatValue(15.5)).toBe('15.5');
      expect(ChartRenderer._formatValue(50)).toBe('50.0');
    });

    it('should format small values with appropriate precision', () => {
      expect(ChartRenderer._formatValue(5.5)).toBe('5.5');
      expect(ChartRenderer._formatValue(0.5)).toBe('0.50');
      expect(ChartRenderer._formatValue(0.05)).toBe('0.05');
    });
  });

  describe('_hexToRgba', () => {
    it('should convert hex to rgba correctly', () => {
      expect(ChartRenderer._hexToRgba('#22c55e', 0.5)).toBe('rgba(34, 197, 94, 0.5)');
      expect(ChartRenderer._hexToRgba('#3b82f6', 0.3)).toBe('rgba(59, 130, 246, 0.3)');
      expect(ChartRenderer._hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
      expect(ChartRenderer._hexToRgba('#ffffff', 0)).toBe('rgba(255, 255, 255, 0)');
    });
  });

  describe('_calculatePoints', () => {
    const testData = [
      { timestamp: 1000, value: 10 },
      { timestamp: 2000, value: 20 },
      { timestamp: 3000, value: 15 },
    ];

    const chartWidth = 200;
    const chartHeight = 100;
    const padding = { top: 10, right: 12, bottom: 20, left: 45 };
    const minY = 0;
    const maxY = 22; // With 10% headroom from 20

    it('should calculate correct x coordinates based on time', () => {
      const points = ChartRenderer._calculatePoints(
        testData,
        chartWidth,
        chartHeight,
        padding,
        minY,
        maxY
      );

      // First point at left edge
      expect(points[0].x).toBe(padding.left);

      // Last point at right edge
      expect(points[2].x).toBe(padding.left + chartWidth);

      // Middle point in between
      expect(points[1].x).toBe(padding.left + chartWidth / 2);
    });

    it('should calculate correct y coordinates based on value', () => {
      const points = ChartRenderer._calculatePoints(
        testData,
        chartWidth,
        chartHeight,
        padding,
        minY,
        maxY
      );

      // Higher value = lower y (canvas coordinates)
      expect(points[1].y).toBeLessThan(points[0].y);
      expect(points[1].y).toBeLessThan(points[2].y);
    });
  });

  describe('renderLineChart', () => {
    it('should handle empty data gracefully', () => {
      const mockCtx = createMockContext();
      const mockCanvas = createMockCanvas(mockCtx);

      ChartRenderer.renderLineChart(mockCanvas, [], {
        color: '#22c55e',
      });

      // Should draw "Collecting data..." message
      expect(mockCtx.fillText).toHaveBeenCalledWith(
        'Collecting data...',
        expect.any(Number),
        expect.any(Number)
      );
    });

    it('should render grid for data with 2+ points', () => {
      const mockCtx = createMockContext();
      const mockCanvas = createMockCanvas(mockCtx);

      const data = [
        { timestamp: 1000, value: 10 },
        { timestamp: 2000, value: 20 },
      ];

      ChartRenderer.renderLineChart(mockCanvas, data, {
        color: '#22c55e',
      });

      // Should draw grid lines
      expect(mockCtx.moveTo).toHaveBeenCalled();
      expect(mockCtx.lineTo).toHaveBeenCalled();
      expect(mockCtx.stroke).toHaveBeenCalled();
    });

    it('should use provided color for line', () => {
      const mockCtx = createMockContext();
      const mockCanvas = createMockCanvas(mockCtx);

      const data = [
        { timestamp: 1000, value: 10 },
        { timestamp: 2000, value: 20 },
      ];

      ChartRenderer.renderLineChart(mockCanvas, data, {
        color: '#ff0000',
      });

      expect(mockCtx.strokeStyle).toBe('#ff0000');
    });

    it('should handle single data point without crashing', () => {
      const mockCtx = createMockContext();
      const mockCanvas = createMockCanvas(mockCtx);

      // Single point - should not draw line but also not crash
      expect(() => {
        ChartRenderer.renderLineChart(
          mockCanvas,
          [{ timestamp: 1000, value: 10 }],
          { color: '#22c55e' }
        );
      }).not.toThrow();
    });
  });
});

// Helper functions for creating mocks

function createMockContext() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    fillText: vi.fn(),
    scale: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    textAlign: '',
    textBaseline: '',
    font: '',
    createLinearGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
  };
}

function createMockCanvas(ctx: ReturnType<typeof createMockContext>) {
  return {
    getContext: vi.fn(() => ctx),
    getBoundingClientRect: vi.fn(() => ({
      width: 300,
      height: 150,
    })),
    width: 0,
    height: 0,
  };
}

// Type declaration for extracted ChartRenderer
declare global {
  var ChartRenderer: {
    colors: {
      throughput: string;
      processCount: string;
      restarts: string;
      queueSize: string;
      memory: string;
    };
    config: {
      gridColor: string;
      labelColor: string;
      lineWidth: number;
      gridLineCount: number;
      padding: { top: number; right: number; bottom: number; left: number };
      fontSize: number;
    };
    renderLineChart: (
      canvas: unknown,
      data: Array<{ timestamp: number; value: number }>,
      options: { color: string; label?: string; minY?: number; maxY?: number }
    ) => void;
    _drawGrid: (...args: unknown[]) => void;
    _drawLine: (...args: unknown[]) => void;
    _drawAreaFill: (...args: unknown[]) => void;
    _calculatePoints: (
      data: Array<{ timestamp: number; value: number }>,
      chartWidth: number,
      chartHeight: number,
      padding: { top: number; right: number; bottom: number; left: number },
      minY: number,
      maxY: number
    ) => Array<{ x: number; y: number }>;
    _drawNoDataMessage: (...args: unknown[]) => void;
    _formatValue: (value: number) => string;
    _hexToRgba: (hex: string, alpha: number) => string;
  };
}
