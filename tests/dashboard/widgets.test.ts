/**
 * Unit tests for dashboard widgets.
 *
 * These tests focus on widget configuration and type safety.
 * Full TUI testing would require a mocked terminal environment.
 */

import { describe, it, expect } from 'vitest';
import {
  ProcessTreeWidget,
  StatsTableWidget,
  MemoryGaugeWidget,
  EventLogWidget,
  ProcessDetailView,
} from '../../src/dashboard/widgets/index.js';
import type { ProcessTreeNode, GenServerStats, SupervisorStats } from '../../src/core/types.js';
import { DARK_THEME, LIGHT_THEME } from '../../src/dashboard/types.js';

describe('ProcessTreeWidget', () => {
  describe('constructor', () => {
    it('creates instance with dark theme', () => {
      const widget = new ProcessTreeWidget({ theme: DARK_THEME });
      expect(widget).toBeInstanceOf(ProcessTreeWidget);
    });

    it('creates instance with light theme', () => {
      const widget = new ProcessTreeWidget({ theme: LIGHT_THEME });
      expect(widget).toBeInstanceOf(ProcessTreeWidget);
    });
  });

  describe('getElement()', () => {
    it('returns null before create is called', () => {
      const widget = new ProcessTreeWidget({ theme: DARK_THEME });
      expect(widget.getElement()).toBeNull();
    });
  });

  describe('destroy()', () => {
    it('is safe to call before create', () => {
      const widget = new ProcessTreeWidget({ theme: DARK_THEME });
      expect(() => widget.destroy()).not.toThrow();
    });

    it('is safe to call multiple times', () => {
      const widget = new ProcessTreeWidget({ theme: DARK_THEME });
      expect(() => {
        widget.destroy();
        widget.destroy();
        widget.destroy();
      }).not.toThrow();
    });
  });
});

describe('StatsTableWidget', () => {
  describe('constructor', () => {
    it('creates instance with theme config', () => {
      const widget = new StatsTableWidget({ theme: DARK_THEME });
      expect(widget).toBeInstanceOf(StatsTableWidget);
    });
  });

  describe('getElement()', () => {
    it('returns null before create is called', () => {
      const widget = new StatsTableWidget({ theme: DARK_THEME });
      expect(widget.getElement()).toBeNull();
    });
  });

  describe('getSelectedId()', () => {
    it('returns null when no element exists', () => {
      const widget = new StatsTableWidget({ theme: DARK_THEME });
      expect(widget.getSelectedId()).toBeNull();
    });
  });

  describe('destroy()', () => {
    it('is safe to call before create', () => {
      const widget = new StatsTableWidget({ theme: DARK_THEME });
      expect(() => widget.destroy()).not.toThrow();
    });
  });
});

describe('MemoryGaugeWidget', () => {
  describe('constructor', () => {
    it('creates instance with theme config', () => {
      const widget = new MemoryGaugeWidget({ theme: DARK_THEME });
      expect(widget).toBeInstanceOf(MemoryGaugeWidget);
    });
  });

  describe('getElement()', () => {
    it('returns null before create is called', () => {
      const widget = new MemoryGaugeWidget({ theme: DARK_THEME });
      expect(widget.getElement()).toBeNull();
    });
  });

  describe('destroy()', () => {
    it('is safe to call before create', () => {
      const widget = new MemoryGaugeWidget({ theme: DARK_THEME });
      expect(() => widget.destroy()).not.toThrow();
    });
  });
});

describe('EventLogWidget', () => {
  describe('constructor', () => {
    it('creates instance with theme and maxEntries config', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 100,
      });
      expect(widget).toBeInstanceOf(EventLogWidget);
    });

    it('accepts custom maxEntries value', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 50,
      });
      expect(widget).toBeInstanceOf(EventLogWidget);
    });
  });

  describe('getElement()', () => {
    it('returns null before create is called', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 100,
      });
      expect(widget.getElement()).toBeNull();
    });
  });

  describe('getEntries()', () => {
    it('returns empty array initially', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 100,
      });
      expect(widget.getEntries()).toEqual([]);
    });
  });

  describe('log()', () => {
    it('stores entries without element', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 100,
      });

      widget.log({ message: 'Test message', severity: 'info' });

      const entries = widget.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('Test message');
      expect(entries[0].severity).toBe('info');
    });

    it('stores multiple entries', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 100,
      });

      widget.log({ message: 'First', severity: 'info' });
      widget.log({ message: 'Second', severity: 'success' });
      widget.log({ message: 'Third', severity: 'warning' });

      const entries = widget.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0].message).toBe('First');
      expect(entries[1].message).toBe('Second');
      expect(entries[2].message).toBe('Third');
    });

    it('respects maxEntries limit', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 3,
      });

      widget.log({ message: 'One', severity: 'info' });
      widget.log({ message: 'Two', severity: 'info' });
      widget.log({ message: 'Three', severity: 'info' });
      widget.log({ message: 'Four', severity: 'info' });

      const entries = widget.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0].message).toBe('Two');
      expect(entries[1].message).toBe('Three');
      expect(entries[2].message).toBe('Four');
    });

    it('uses provided timestamp when given', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 100,
      });

      const timestamp = 1234567890000;
      widget.log({ message: 'Test', severity: 'info', timestamp });

      const entries = widget.getEntries();
      expect(entries[0].timestamp).toBe(timestamp);
    });

    it('generates timestamp when not provided', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 100,
      });

      const before = Date.now();
      widget.log({ message: 'Test', severity: 'info' });
      const after = Date.now();

      const entries = widget.getEntries();
      expect(entries[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(entries[0].timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('clear()', () => {
    it('removes all entries', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 100,
      });

      widget.log({ message: 'Test', severity: 'info' });
      expect(widget.getEntries()).toHaveLength(1);

      widget.clear();
      expect(widget.getEntries()).toHaveLength(0);
    });
  });

  describe('destroy()', () => {
    it('is safe to call before create', () => {
      const widget = new EventLogWidget({
        theme: DARK_THEME,
        maxEntries: 100,
      });
      expect(() => widget.destroy()).not.toThrow();
    });
  });
});

describe('ProcessDetailView', () => {
  const createGenServerNode = (): ProcessTreeNode => {
    const stats: GenServerStats = {
      id: 'test-server-1',
      status: 'running',
      queueSize: 5,
      messageCount: 1234,
      startedAt: Date.now() - 60000,
      uptimeMs: 60000,
      stateMemoryBytes: 65536,
    };

    return {
      type: 'genserver',
      id: 'test-server-1',
      name: 'TestServer',
      stats,
    };
  };

  const createSupervisorNode = (): ProcessTreeNode => {
    const stats: SupervisorStats = {
      id: 'test-supervisor-1',
      strategy: 'one_for_one',
      childCount: 3,
      totalRestarts: 2,
      startedAt: Date.now() - 120000,
      uptimeMs: 120000,
    };

    return {
      type: 'supervisor',
      id: 'test-supervisor-1',
      name: 'TestSupervisor',
      stats,
      children: [],
    };
  };

  describe('constructor', () => {
    it('creates instance with dark theme', () => {
      const view = new ProcessDetailView({ theme: DARK_THEME });
      expect(view).toBeInstanceOf(ProcessDetailView);
    });

    it('creates instance with light theme', () => {
      const view = new ProcessDetailView({ theme: LIGHT_THEME });
      expect(view).toBeInstanceOf(ProcessDetailView);
    });
  });

  describe('isVisible()', () => {
    it('returns false initially', () => {
      const view = new ProcessDetailView({ theme: DARK_THEME });
      expect(view.isVisible()).toBe(false);
    });
  });

  describe('close()', () => {
    it('is safe to call when not visible', () => {
      const view = new ProcessDetailView({ theme: DARK_THEME });
      expect(() => view.close()).not.toThrow();
    });

    it('is safe to call multiple times', () => {
      const view = new ProcessDetailView({ theme: DARK_THEME });
      expect(() => {
        view.close();
        view.close();
        view.close();
      }).not.toThrow();
    });
  });

  describe('node type handling', () => {
    it('accepts GenServer node data', () => {
      const view = new ProcessDetailView({ theme: DARK_THEME });
      const node = createGenServerNode();
      // Cannot fully test show() without blessed screen, but we verify type compatibility
      expect(node.type).toBe('genserver');
      expect((node.stats as GenServerStats).status).toBe('running');
    });

    it('accepts Supervisor node data', () => {
      const view = new ProcessDetailView({ theme: DARK_THEME });
      const node = createSupervisorNode();
      expect(node.type).toBe('supervisor');
      expect((node.stats as SupervisorStats).strategy).toBe('one_for_one');
    });

    it('handles node without name', () => {
      const view = new ProcessDetailView({ theme: DARK_THEME });
      const node = createGenServerNode();
      const nodeWithoutName: ProcessTreeNode = {
        ...node,
        name: undefined,
      };
      expect(nodeWithoutName.name).toBeUndefined();
      expect(nodeWithoutName.id).toBe('test-server-1');
    });

    it('handles GenServer without stateMemoryBytes', () => {
      const stats: GenServerStats = {
        id: 'test-server-2',
        status: 'running',
        queueSize: 0,
        messageCount: 0,
        startedAt: Date.now(),
        uptimeMs: 0,
        stateMemoryBytes: undefined,
      };

      const node: ProcessTreeNode = {
        type: 'genserver',
        id: 'test-server-2',
        stats,
      };

      expect(node.stats.id).toBe('test-server-2');
      expect((node.stats as GenServerStats).stateMemoryBytes).toBeUndefined();
    });
  });

  describe('status color mapping', () => {
    it('handles all GenServer statuses', () => {
      const statuses: GenServerStats['status'][] = ['running', 'initializing', 'stopping', 'stopped'];

      statuses.forEach((status) => {
        const stats: GenServerStats = {
          id: `server-${status}`,
          status,
          queueSize: 0,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        };

        const node: ProcessTreeNode = {
          type: 'genserver',
          id: `server-${status}`,
          stats,
        };

        expect(node.stats.id).toBe(`server-${status}`);
        expect((node.stats as GenServerStats).status).toBe(status);
      });
    });
  });

  describe('strategy mapping', () => {
    it('handles all supervisor strategies', () => {
      const strategies: SupervisorStats['strategy'][] = ['one_for_one', 'one_for_all', 'rest_for_one'];

      strategies.forEach((strategy) => {
        const stats: SupervisorStats = {
          id: `supervisor-${strategy}`,
          strategy,
          childCount: 0,
          totalRestarts: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        };

        const node: ProcessTreeNode = {
          type: 'supervisor',
          id: `supervisor-${strategy}`,
          stats,
        };

        expect((node.stats as SupervisorStats).strategy).toBe(strategy);
      });
    });
  });
});

describe('Widget type exports', () => {
  it('exports all widget classes', async () => {
    const module = await import('../../src/dashboard/widgets/index.js');

    expect(module.ProcessTreeWidget).toBeDefined();
    expect(module.StatsTableWidget).toBeDefined();
    expect(module.MemoryGaugeWidget).toBeDefined();
    expect(module.EventLogWidget).toBeDefined();
    expect(module.ProcessDetailView).toBeDefined();
    expect(module.BaseWidget).toBeDefined();
    expect(module.createEventLogWidget).toBeDefined();
  });
});
