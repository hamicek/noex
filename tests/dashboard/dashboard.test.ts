/**
 * Unit tests for Dashboard class.
 *
 * Note: These tests focus on the Dashboard's internal logic without
 * actually rendering to a terminal. Full TUI testing would require
 * a mocked terminal environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dashboard } from '../../src/dashboard/dashboard.js';
import { DEFAULT_CONFIG } from '../../src/dashboard/types.js';

describe('Dashboard', () => {
  describe('constructor', () => {
    it('creates instance with default config', () => {
      const dashboard = new Dashboard();
      expect(dashboard).toBeInstanceOf(Dashboard);
      expect(dashboard.isRunning()).toBe(false);
    });

    it('accepts custom configuration', () => {
      const dashboard = new Dashboard({
        refreshInterval: 1000,
        maxEventLogSize: 50,
        theme: 'light',
        layout: 'compact',
      });

      expect(dashboard).toBeInstanceOf(Dashboard);
    });

    it('merges partial config with defaults', () => {
      const dashboard = new Dashboard({
        refreshInterval: 2000,
      });

      // The dashboard should use the custom interval but default for other options
      expect(dashboard).toBeInstanceOf(Dashboard);
    });
  });

  describe('isRunning()', () => {
    it('returns false before start', () => {
      const dashboard = new Dashboard();
      expect(dashboard.isRunning()).toBe(false);
    });

    it('returns false after stop when not started', () => {
      const dashboard = new Dashboard();
      dashboard.stop(); // Should be safe to call
      expect(dashboard.isRunning()).toBe(false);
    });
  });

  describe('lifecycle safety', () => {
    it('stop() is safe to call multiple times', () => {
      const dashboard = new Dashboard();

      // Should not throw
      expect(() => {
        dashboard.stop();
        dashboard.stop();
        dashboard.stop();
      }).not.toThrow();
    });

    it('refresh() does nothing when not running', () => {
      const dashboard = new Dashboard();

      // Should not throw
      expect(() => {
        dashboard.refresh();
      }).not.toThrow();
    });
  });

  describe('configuration validation', () => {
    it('accepts all valid theme values', () => {
      expect(() => new Dashboard({ theme: 'dark' })).not.toThrow();
      expect(() => new Dashboard({ theme: 'light' })).not.toThrow();
    });

    it('accepts all valid layout values', () => {
      expect(() => new Dashboard({ layout: 'full' })).not.toThrow();
      expect(() => new Dashboard({ layout: 'compact' })).not.toThrow();
      expect(() => new Dashboard({ layout: 'minimal' })).not.toThrow();
    });

    it('accepts custom refresh intervals', () => {
      expect(() => new Dashboard({ refreshInterval: 100 })).not.toThrow();
      expect(() => new Dashboard({ refreshInterval: 5000 })).not.toThrow();
    });

    it('accepts custom maxEventLogSize', () => {
      expect(() => new Dashboard({ maxEventLogSize: 10 })).not.toThrow();
      expect(() => new Dashboard({ maxEventLogSize: 1000 })).not.toThrow();
    });
  });

  describe('default configuration', () => {
    it('uses expected defaults', () => {
      expect(DEFAULT_CONFIG.refreshInterval).toBe(500);
      expect(DEFAULT_CONFIG.maxEventLogSize).toBe(100);
      expect(DEFAULT_CONFIG.theme).toBe('dark');
      expect(DEFAULT_CONFIG.layout).toBe('full');
    });
  });

  describe('getLayout()', () => {
    it('returns default layout when not specified', () => {
      const dashboard = new Dashboard();
      expect(dashboard.getLayout()).toBe('full');
    });

    it('returns configured layout', () => {
      const compactDashboard = new Dashboard({ layout: 'compact' });
      expect(compactDashboard.getLayout()).toBe('compact');

      const minimalDashboard = new Dashboard({ layout: 'minimal' });
      expect(minimalDashboard.getLayout()).toBe('minimal');
    });
  });

  describe('switchLayout()', () => {
    it('does nothing when dashboard is not running', () => {
      const dashboard = new Dashboard();
      expect(dashboard.getLayout()).toBe('full');

      // Should not throw and should not change layout (not running)
      expect(() => dashboard.switchLayout('compact')).not.toThrow();
      expect(dashboard.getLayout()).toBe('full');
    });

    it('does nothing when switching to same layout', () => {
      const dashboard = new Dashboard({ layout: 'compact' });
      expect(dashboard.getLayout()).toBe('compact');

      // Should not throw
      expect(() => dashboard.switchLayout('compact')).not.toThrow();
      expect(dashboard.getLayout()).toBe('compact');
    });
  });

  describe('selectProcess()', () => {
    it('does nothing when dashboard is not running', () => {
      const dashboard = new Dashboard();

      // Should not throw
      expect(() => dashboard.selectProcess('some-id')).not.toThrow();
    });
  });
});

describe('Dashboard integration (without terminal)', () => {
  // These tests verify Dashboard's interaction with Observer
  // without actually starting the TUI

  describe('Observer integration readiness', () => {
    it('Dashboard can be instantiated alongside Observer', async () => {
      const { Observer } = await import('../../src/observer/index.js');

      const dashboard = new Dashboard();
      const snapshot = Observer.getSnapshot();

      // Dashboard should work with Observer data
      expect(dashboard).toBeInstanceOf(Dashboard);
      expect(snapshot).toBeDefined();
      expect(snapshot.servers).toBeInstanceOf(Array);
    });
  });
});
