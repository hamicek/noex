/**
 * Comprehensive tests for AlertManager module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GenServer,
  Supervisor,
  Registry,
  Observer,
  AlertManager,
  type GenServerBehavior,
  type AlertEvent,
  type Alert,
} from '../../src/index.js';

function createCounterBehavior(): GenServerBehavior<number, 'get', 'inc', number> {
  return {
    init: () => 0,
    handleCall: (msg, state) => {
      if (msg === 'get') return [state, state];
      throw new Error('Unknown message');
    },
    handleCast: (msg, state) => {
      if (msg === 'inc') return state + 1;
      return state;
    },
  };
}

describe('AlertManager', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    Supervisor._clearLifecycleHandlers();
    Supervisor._resetIdCounter();
    Registry._clearLifecycleHandler();
    Registry._clear();
    Observer._reset();
    AlertManager.reset();
    AlertManager._clearSubscribers();
  });

  afterEach(async () => {
    Observer._reset();
    AlertManager.reset();
    AlertManager._clearSubscribers();
    await Supervisor._clearAll();
    GenServer._clearLifecycleHandlers();
    Registry._clearLifecycleHandler();
    Registry._clear();
  });

  describe('configure()', () => {
    it('uses default configuration initially', () => {
      const config = AlertManager.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.sensitivityMultiplier).toBe(2.0);
      expect(config.minSamples).toBe(30);
      expect(config.cooldownMs).toBe(10000);
    });

    it('allows partial configuration updates', () => {
      AlertManager.configure({ sensitivityMultiplier: 3.0 });

      const config = AlertManager.getConfig();
      expect(config.sensitivityMultiplier).toBe(3.0);
      expect(config.minSamples).toBe(30); // unchanged
    });

    it('allows disabling alerts', () => {
      AlertManager.configure({ enabled: false });

      const config = AlertManager.getConfig();
      expect(config.enabled).toBe(false);
    });
  });

  describe('recordQueueSize()', () => {
    it('records samples for a process', () => {
      AlertManager.recordQueueSize('process-1', 5);
      AlertManager.recordQueueSize('process-1', 10);
      AlertManager.recordQueueSize('process-1', 15);

      const stats = AlertManager.getProcessStatistics('process-1');
      expect(stats).toBeDefined();
      expect(stats!.sampleCount).toBe(3);
    });

    it('computes mean correctly', () => {
      AlertManager.recordQueueSize('process-1', 10);
      AlertManager.recordQueueSize('process-1', 20);
      AlertManager.recordQueueSize('process-1', 30);

      const stats = AlertManager.getProcessStatistics('process-1');
      expect(stats!.mean).toBe(20);
    });

    it('computes standard deviation correctly', () => {
      // Values: 2, 4, 4, 4, 5, 5, 7, 9
      // Mean = 5, Variance = 4, StdDev = 2
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      for (const v of values) {
        AlertManager.recordQueueSize('process-1', v);
      }

      const stats = AlertManager.getProcessStatistics('process-1');
      expect(stats!.mean).toBe(5);
      expect(stats!.stddev).toBeCloseTo(2.138, 2);
    });

    it('handles multiple processes independently', () => {
      AlertManager.recordQueueSize('process-1', 100);
      AlertManager.recordQueueSize('process-2', 200);

      const stats1 = AlertManager.getProcessStatistics('process-1');
      const stats2 = AlertManager.getProcessStatistics('process-2');

      expect(stats1!.mean).toBe(100);
      expect(stats2!.mean).toBe(200);
    });
  });

  describe('getThreshold()', () => {
    it('returns Infinity when no data exists', () => {
      const threshold = AlertManager.getThreshold('unknown-process');
      expect(threshold).toBe(Infinity);
    });

    it('returns Infinity when insufficient samples', () => {
      AlertManager.configure({ minSamples: 30 });

      for (let i = 0; i < 20; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      const threshold = AlertManager.getThreshold('process-1');
      expect(threshold).toBe(Infinity);
    });

    it('calculates threshold as mean + multiplier * stddev', () => {
      AlertManager.configure({ minSamples: 5, sensitivityMultiplier: 2.0 });

      // Record 10 samples of value 10 (stddev will be 0)
      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      const stats = AlertManager.getProcessStatistics('process-1');
      const threshold = AlertManager.getThreshold('process-1');

      expect(threshold).toBe(stats!.mean + 2.0 * stats!.stddev);
    });

    it('increases with higher sensitivity multiplier', () => {
      AlertManager.configure({ minSamples: 5, sensitivityMultiplier: 1.0 });

      // Record samples with some variance
      const values = [10, 12, 8, 11, 9, 10, 11, 9, 10, 10];
      for (const v of values) {
        AlertManager.recordQueueSize('process-1', v);
      }

      const threshold1 = AlertManager.getThreshold('process-1');

      AlertManager.configure({ sensitivityMultiplier: 3.0 });
      // Threshold is recalculated on next sample or check
      AlertManager.recordQueueSize('process-1', 10);

      const threshold3 = AlertManager.getThreshold('process-1');

      expect(threshold3).toBeGreaterThan(threshold1);
    });
  });

  describe('checkAlerts()', () => {
    it('does not trigger alerts when disabled', () => {
      AlertManager.configure({ enabled: false, minSamples: 1 });

      const events: AlertEvent[] = [];
      AlertManager.subscribe((e) => events.push(e));

      AlertManager.recordQueueSize('process-1', 10);
      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 1000,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      expect(events).toHaveLength(0);
    });

    it('does not trigger alerts with insufficient samples', () => {
      AlertManager.configure({ minSamples: 30 });

      const events: AlertEvent[] = [];
      AlertManager.subscribe((e) => events.push(e));

      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 5);
      }

      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 1000,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      expect(events).toHaveLength(0);
    });

    it('triggers alert when value exceeds threshold', () => {
      AlertManager.configure({ minSamples: 5, cooldownMs: 0 });

      const events: AlertEvent[] = [];
      AlertManager.subscribe((e) => events.push(e));

      // Build up normal samples
      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      // Now check with high value
      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 100, // Way above threshold
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('alert_triggered');
      if (events[0]!.type === 'alert_triggered') {
        expect(events[0]!.alert.processId).toBe('process-1');
        expect(events[0]!.alert.type).toBe('high_queue_size');
        expect(events[0]!.alert.currentValue).toBe(100);
      }
    });

    it('resolves alert when value drops below threshold', () => {
      AlertManager.configure({ minSamples: 5, cooldownMs: 0 });

      const events: AlertEvent[] = [];
      AlertManager.subscribe((e) => events.push(e));

      // Build up normal samples
      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      // Trigger alert
      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 100,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      // Value back to normal
      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 5,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      expect(events).toHaveLength(2);
      expect(events[1]!.type).toBe('alert_resolved');
      if (events[1]!.type === 'alert_resolved') {
        expect(events[1]!.processId).toBe('process-1');
      }
    });

    it('respects cooldown period', async () => {
      AlertManager.configure({ cooldownMs: 100 });

      const events: AlertEvent[] = [];
      AlertManager.subscribe((e) => events.push(e));

      // First alert - triggers
      const alert1 = AlertManager.triggerAlert('high_queue_size', 'process-1', 150);
      expect(alert1).toBeDefined();

      const alertCountAfterFirst = events.filter(
        (e) => e.type === 'alert_triggered',
      ).length;
      expect(alertCountAfterFirst).toBe(1);

      // Resolve the alert
      AlertManager.resolveAlert('process-1');

      // Second trigger immediately - should not trigger due to cooldown
      const alert2 = AlertManager.triggerAlert('high_queue_size', 'process-1', 200);
      expect(alert2).toBeUndefined();

      const alertCountAfterSecond = events.filter(
        (e) => e.type === 'alert_triggered',
      ).length;
      expect(alertCountAfterSecond).toBe(1); // Still just 1

      // Wait for cooldown to expire
      await new Promise((r) => setTimeout(r, 150));

      // Now it should trigger
      const alert3 = AlertManager.triggerAlert('high_queue_size', 'process-1', 250);
      expect(alert3).toBeDefined();

      const alertCountAfterCooldown = events.filter(
        (e) => e.type === 'alert_triggered',
      ).length;
      expect(alertCountAfterCooldown).toBe(2);
    });

    it('cleans up alerts for removed processes', () => {
      AlertManager.configure({ minSamples: 5, cooldownMs: 0 });

      const events: AlertEvent[] = [];
      AlertManager.subscribe((e) => events.push(e));

      // Build samples and trigger alert
      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 100,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      expect(AlertManager.getActiveAlerts()).toHaveLength(1);

      // Process no longer exists
      AlertManager.checkAlerts([]);

      expect(AlertManager.getActiveAlerts()).toHaveLength(0);
      expect(events).toHaveLength(2);
      expect(events[1]!.type).toBe('alert_resolved');
    });
  });

  describe('getActiveAlerts()', () => {
    it('returns empty array initially', () => {
      expect(AlertManager.getActiveAlerts()).toEqual([]);
    });

    it('returns currently active alerts', () => {
      AlertManager.configure({ minSamples: 5, cooldownMs: 0 });

      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 100,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      const alerts = AlertManager.getActiveAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.processId).toBe('process-1');
    });
  });

  describe('getAlertForProcess()', () => {
    it('returns undefined when no alert exists', () => {
      expect(AlertManager.getAlertForProcess('unknown')).toBeUndefined();
    });

    it('returns alert for specific process', () => {
      AlertManager.configure({ minSamples: 5, cooldownMs: 0 });

      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 100,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      const alert = AlertManager.getAlertForProcess('process-1');
      expect(alert).toBeDefined();
      expect(alert!.processId).toBe('process-1');
    });
  });

  describe('subscribe()', () => {
    it('calls handler on alert trigger', () => {
      AlertManager.configure({ minSamples: 5, cooldownMs: 0 });

      const events: AlertEvent[] = [];
      const unsubscribe = AlertManager.subscribe((e) => events.push(e));

      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 100,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      expect(events).toHaveLength(1);
      unsubscribe();
    });

    it('unsubscribe stops notifications', () => {
      AlertManager.configure({ minSamples: 5, cooldownMs: 0 });

      const events: AlertEvent[] = [];
      const unsubscribe = AlertManager.subscribe((e) => events.push(e));

      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      unsubscribe();

      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 100,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      expect(events).toHaveLength(0);
    });

    it('supports multiple subscribers', () => {
      AlertManager.configure({ minSamples: 5, cooldownMs: 0 });

      const events1: AlertEvent[] = [];
      const events2: AlertEvent[] = [];

      const unsub1 = AlertManager.subscribe((e) => events1.push(e));
      const unsub2 = AlertManager.subscribe((e) => events2.push(e));

      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 100,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);

      unsub1();
      unsub2();
    });

    it('continues notifying other subscribers on handler error', () => {
      AlertManager.configure({ minSamples: 5, cooldownMs: 0 });

      const events: AlertEvent[] = [];

      AlertManager.subscribe(() => {
        throw new Error('Handler error');
      });
      AlertManager.subscribe((e) => events.push(e));

      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 100,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      expect(events).toHaveLength(1);
    });
  });

  describe('triggerAlert()', () => {
    it('manually triggers an alert', () => {
      const events: AlertEvent[] = [];
      AlertManager.subscribe((e) => events.push(e));

      const alert = AlertManager.triggerAlert('high_queue_size', 'process-1', 150);

      expect(alert).toBeDefined();
      expect(alert!.type).toBe('high_queue_size');
      expect(alert!.processId).toBe('process-1');
      expect(alert!.currentValue).toBe(150);
      expect(events).toHaveLength(1);
    });

    it('returns undefined when disabled', () => {
      AlertManager.configure({ enabled: false });

      const alert = AlertManager.triggerAlert('high_queue_size', 'process-1', 150);
      expect(alert).toBeUndefined();
    });

    it('respects cooldown', async () => {
      AlertManager.configure({ cooldownMs: 100 });

      const alert1 = AlertManager.triggerAlert('high_queue_size', 'process-1', 150);
      expect(alert1).toBeDefined();

      const alert2 = AlertManager.triggerAlert('high_queue_size', 'process-1', 200);
      expect(alert2).toBeUndefined();

      await new Promise((r) => setTimeout(r, 150));

      const alert3 = AlertManager.triggerAlert('high_queue_size', 'process-1', 250);
      expect(alert3).toBeDefined();
    });
  });

  describe('resolveAlert()', () => {
    it('manually resolves an alert', () => {
      AlertManager.triggerAlert('high_queue_size', 'process-1', 150);

      const events: AlertEvent[] = [];
      AlertManager.subscribe((e) => events.push(e));

      const result = AlertManager.resolveAlert('process-1');

      expect(result).toBe(true);
      expect(AlertManager.getActiveAlerts()).toHaveLength(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('alert_resolved');
    });

    it('returns false when no alert exists', () => {
      const result = AlertManager.resolveAlert('unknown');
      expect(result).toBe(false);
    });
  });

  describe('removeProcess()', () => {
    it('removes process statistics', () => {
      AlertManager.recordQueueSize('process-1', 10);
      expect(AlertManager.getProcessStatistics('process-1')).toBeDefined();

      AlertManager.removeProcess('process-1');
      expect(AlertManager.getProcessStatistics('process-1')).toBeUndefined();
    });

    it('resolves active alert for removed process', () => {
      AlertManager.triggerAlert('high_queue_size', 'process-1', 150);
      expect(AlertManager.getActiveAlerts()).toHaveLength(1);

      const events: AlertEvent[] = [];
      AlertManager.subscribe((e) => events.push(e));

      AlertManager.removeProcess('process-1');

      expect(AlertManager.getActiveAlerts()).toHaveLength(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('alert_resolved');
    });
  });

  describe('reset()', () => {
    it('clears all state', () => {
      AlertManager.recordQueueSize('process-1', 10);
      AlertManager.triggerAlert('high_queue_size', 'process-1', 150);

      AlertManager.reset();

      expect(AlertManager.getProcessStatistics('process-1')).toBeUndefined();
      expect(AlertManager.getActiveAlerts()).toHaveLength(0);
    });
  });

  describe('integration with Observer', () => {
    it('receives alerts through Observer.subscribeToAlerts', async () => {
      AlertManager.configure({ minSamples: 2, cooldownMs: 0 });

      const events: AlertEvent[] = [];
      const unsubscribe = Observer.subscribeToAlerts((e) => events.push(e));

      const ref = await GenServer.start(createCounterBehavior());

      // Record some samples
      for (let i = 0; i < 5; i++) {
        AlertManager.recordQueueSize(ref.id, 0);
      }

      // Manually trigger an alert for testing
      AlertManager.triggerAlert('high_queue_size', ref.id, 100);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('alert_triggered');

      unsubscribe();
      await GenServer.stop(ref);
    });

    it('Observer.getActiveAlerts returns alerts from AlertManager', () => {
      AlertManager.triggerAlert('high_queue_size', 'process-1', 150);

      const alerts = Observer.getActiveAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.processId).toBe('process-1');
    });

    it('Observer._reset clears AlertManager state', () => {
      AlertManager.recordQueueSize('process-1', 10);
      AlertManager.triggerAlert('high_queue_size', 'process-1', 150);

      Observer._reset();

      expect(AlertManager.getProcessStatistics('process-1')).toBeUndefined();
      expect(AlertManager.getActiveAlerts()).toHaveLength(0);
    });
  });

  describe('alert message formatting', () => {
    it('includes process ID in message', () => {
      const alert = AlertManager.triggerAlert('high_queue_size', 'server-42', 100);
      expect(alert!.message).toContain('server-42');
    });

    it('includes process name when registered', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('my-counter', ref);

      const alert = AlertManager.triggerAlert('high_queue_size', ref.id, 100);
      expect(alert!.message).toContain('my-counter');
      expect(alert!.processName).toBe('my-counter');

      await GenServer.stop(ref);
    });

    it('includes threshold and current value', () => {
      AlertManager.configure({ minSamples: 5 });

      for (let i = 0; i < 10; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      AlertManager.checkAlerts([
        {
          id: 'process-1',
          status: 'running',
          queueSize: 100,
          messageCount: 0,
          startedAt: Date.now(),
          uptimeMs: 0,
        },
      ]);

      const alert = AlertManager.getAlertForProcess('process-1');
      expect(alert!.message).toContain('100');
      expect(alert!.currentValue).toBe(100);
      expect(alert!.threshold).toBeGreaterThan(0);
    });
  });

  describe('circular buffer behavior', () => {
    it('maintains fixed sample size', () => {
      AlertManager.configure({ minSamples: 5 });

      // Record more than MAX_SAMPLES (1000)
      for (let i = 0; i < 1500; i++) {
        AlertManager.recordQueueSize('process-1', i);
      }

      const stats = AlertManager.getProcessStatistics('process-1');
      expect(stats!.sampleCount).toBe(1000);
    });

    it('uses recent samples for statistics', () => {
      AlertManager.configure({ minSamples: 5 });

      // Record 1000 samples of 10
      for (let i = 0; i < 1000; i++) {
        AlertManager.recordQueueSize('process-1', 10);
      }

      // Record 500 samples of 100
      for (let i = 0; i < 500; i++) {
        AlertManager.recordQueueSize('process-1', 100);
      }

      const stats = AlertManager.getProcessStatistics('process-1');
      // Mean should be closer to 100 than to 10 as recent values dominate
      // (500 values of 10 + 500 values of 100) / 1000 = 55
      expect(stats!.mean).toBe(55);
    });
  });
});
