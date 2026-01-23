import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer } from '../../src/core/gen-server.js';
import type {
  GenServerBehavior,
  GenServerRef,
  ExitSignal,
  LinkRef,
  LifecycleEvent,
} from '../../src/core/types.js';

/**
 * Tests for GenServer.link() and GenServer.unlink() functionality.
 *
 * Tests local (same-node) bidirectional process linking where:
 * - When one linked process terminates abnormally, the other is also terminated
 * - Normal exits do not propagate through links
 * - trapExit converts propagation into info messages via handleInfo
 * - Unlink prevents future propagation
 */

// Simple counter behavior for testing
const createCounterBehavior = (): GenServerBehavior<
  number,
  { type: 'get' } | { type: 'inc' },
  { type: 'inc' } | { type: 'crash' },
  number
> => ({
  init: () => 0,
  handleCall: (msg, state) => {
    if (msg.type === 'get') return [state, state];
    if (msg.type === 'inc') return [state + 1, state + 1];
    return [state, state];
  },
  handleCast: (msg, state) => {
    if (msg.type === 'inc') return state + 1;
    if (msg.type === 'crash') throw new Error('Intentional crash');
    return state;
  },
});

// Behavior that crashes on a specific call
const createCrashingBehavior = (): GenServerBehavior<
  number,
  { type: 'get' } | { type: 'crash' },
  never,
  number
> => ({
  init: () => 0,
  handleCall: (msg, state) => {
    if (msg.type === 'get') return [state, state];
    if (msg.type === 'crash') throw new Error('Intentional crash');
    return [state, state];
  },
  handleCast: (_msg, state) => state,
});

// Behavior with trapExit that records received exit signals
const createTrapExitBehavior = (): GenServerBehavior<
  { count: number; exitSignals: ExitSignal[] },
  { type: 'get' } | { type: 'getExitSignals' },
  { type: 'inc' },
  number | ExitSignal[]
> => ({
  init: () => ({ count: 0, exitSignals: [] }),
  handleCall: (msg, state) => {
    if (msg.type === 'get') return [state.count, state];
    if (msg.type === 'getExitSignals') return [state.exitSignals, state];
    return [state.count, state];
  },
  handleCast: (msg, state) => {
    if (msg.type === 'inc') return { ...state, count: state.count + 1 };
    return state;
  },
  handleInfo: (info, state) => {
    return { ...state, exitSignals: [...state.exitSignals, info] };
  },
});

describe('GenServer.link', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._clearLocalMonitors();
    GenServer._clearLocalLinks();
    GenServer._resetIdCounter();
  });

  afterEach(async () => {
    // Cleanup any running servers
    const serverIds = GenServer._getAllServerIds();
    for (const id of serverIds) {
      const ref = GenServer._getRefById(id);
      if (ref) {
        try {
          await GenServer.stop(ref);
        } catch {
          // Ignore errors during cleanup
        }
      }
    }
    GenServer._clearLifecycleHandlers();
    GenServer._clearLocalMonitors();
    GenServer._clearLocalLinks();
  });

  // ===========================================================================
  // Basic Link Setup
  // ===========================================================================

  describe('link setup', () => {
    it('returns a LinkRef on successful link setup', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      const linkRef = await GenServer.link(serverA, serverB);

      expect(linkRef).toBeDefined();
      expect(linkRef.linkId).toBeDefined();
      expect(typeof linkRef.linkId).toBe('string');
      expect(linkRef.ref1.id).toBe(serverA.id);
      expect(linkRef.ref2.id).toBe(serverB.id);
    });

    it('registers link in the link registry', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      expect(GenServer._getLocalLinkCount()).toBe(0);

      await GenServer.link(serverA, serverB);

      expect(GenServer._getLocalLinkCount()).toBe(1);
    });

    it('allows multiple links between different process pairs', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());
      const serverC = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);
      await GenServer.link(serverA, serverC);
      await GenServer.link(serverB, serverC);

      expect(GenServer._getLocalLinkCount()).toBe(3);
    });

    it('throws ServerNotRunningError when ref1 is not running', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());
      await GenServer.stop(serverA);

      await expect(GenServer.link(serverA, serverB)).rejects.toThrow('not running');
    });

    it('throws ServerNotRunningError when ref2 is not running', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());
      await GenServer.stop(serverB);

      await expect(GenServer.link(serverA, serverB)).rejects.toThrow('not running');
    });

    it('allows a process to link to itself', async () => {
      const server = await GenServer.start(createCounterBehavior());

      const linkRef = await GenServer.link(server, server);

      expect(linkRef).toBeDefined();
      expect(GenServer._getLocalLinkCount()).toBe(1);
    });
  });

  // ===========================================================================
  // Exit Propagation (Crash)
  // ===========================================================================

  describe('exit propagation on crash', () => {
    it('terminates linked process when one crashes via _forceTerminate', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      // Force terminate B with error
      GenServer._forceTerminate(serverB, { error: new Error('crash') });

      // A should also be terminated
      expect(GenServer.isRunning(serverA)).toBe(false);
    });

    it('terminates linked process when one crashes via stop with error', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      // Stop B with error reason
      await GenServer.stop(serverB, { error: new Error('crash') });

      // A should also be terminated
      expect(GenServer.isRunning(serverA)).toBe(false);
    });

    it('propagates termination with shutdown reason', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      // Stop B with shutdown reason
      await GenServer.stop(serverB, 'shutdown');

      // A should also be terminated (shutdown is abnormal)
      expect(GenServer.isRunning(serverA)).toBe(false);
    });

    it('emits terminated lifecycle event for both processes', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      const events: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        if (event.type === 'terminated') {
          events.push(event);
        }
      });

      GenServer._forceTerminate(serverB, { error: new Error('crash') });

      // Both should have terminated events
      const terminatedIds = events
        .filter((e) => e.type === 'terminated')
        .map((e) => e.ref.id);
      expect(terminatedIds).toContain(serverA.id);
      expect(terminatedIds).toContain(serverB.id);
    });

    it('cascades through chain: A--B--C', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());
      const serverC = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);
      await GenServer.link(serverB, serverC);

      // Crash A - should cascade through B to C
      GenServer._forceTerminate(serverA, { error: new Error('crash') });

      expect(GenServer.isRunning(serverA)).toBe(false);
      expect(GenServer.isRunning(serverB)).toBe(false);
      expect(GenServer.isRunning(serverC)).toBe(false);
    });

    it('removes link from registry after propagation', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);
      expect(GenServer._getLocalLinkCount()).toBe(1);

      GenServer._forceTerminate(serverB, { error: new Error('crash') });

      expect(GenServer._getLocalLinkCount()).toBe(0);
    });
  });

  // ===========================================================================
  // Normal Exit (No Propagation)
  // ===========================================================================

  describe('normal exit does not propagate', () => {
    it('does not terminate linked process on normal stop', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      // Stop B normally
      await GenServer.stop(serverB, 'normal');

      // A should still be running
      expect(GenServer.isRunning(serverA)).toBe(true);
    });

    it('removes link from registry on normal stop', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);
      expect(GenServer._getLocalLinkCount()).toBe(1);

      await GenServer.stop(serverB, 'normal');

      expect(GenServer._getLocalLinkCount()).toBe(0);
    });

    it('does not propagate default stop (which is normal)', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      // Default stop reason is 'normal'
      await GenServer.stop(serverB);

      expect(GenServer.isRunning(serverA)).toBe(true);
    });
  });

  // ===========================================================================
  // trapExit Behavior
  // ===========================================================================

  describe('trapExit', () => {
    it('delivers ExitSignal via handleInfo instead of terminating', async () => {
      const serverA = await GenServer.start(createTrapExitBehavior(), { trapExit: true });
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      // Crash B
      GenServer._forceTerminate(serverB, { error: new Error('crash') });

      // A should still be running (trapExit prevents termination)
      expect(GenServer.isRunning(serverA)).toBe(true);

      // Wait for info message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // A should have received the exit signal
      const exitSignals = await GenServer.call(serverA, { type: 'getExitSignals' }) as ExitSignal[];
      expect(exitSignals).toHaveLength(1);
      expect(exitSignals[0]!.type).toBe('EXIT');
      expect(exitSignals[0]!.from.id).toBe(serverB.id);
      expect(exitSignals[0]!.reason.type).toBe('error');
    });

    it('delivers ExitSignal with shutdown reason', async () => {
      const serverA = await GenServer.start(createTrapExitBehavior(), { trapExit: true });
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      // Stop B with shutdown
      await GenServer.stop(serverB, 'shutdown');

      // Wait for info message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(GenServer.isRunning(serverA)).toBe(true);

      const exitSignals = await GenServer.call(serverA, { type: 'getExitSignals' }) as ExitSignal[];
      expect(exitSignals).toHaveLength(1);
      expect(exitSignals[0]!.reason.type).toBe('shutdown');
    });

    it('does not deliver ExitSignal on normal exit', async () => {
      const serverA = await GenServer.start(createTrapExitBehavior(), { trapExit: true });
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      // Stop B normally
      await GenServer.stop(serverB, 'normal');

      // Wait for potential info message
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(GenServer.isRunning(serverA)).toBe(true);

      const exitSignals = await GenServer.call(serverA, { type: 'getExitSignals' }) as ExitSignal[];
      expect(exitSignals).toHaveLength(0);
    });

    it('handles multiple exit signals from multiple linked processes', async () => {
      const serverA = await GenServer.start(createTrapExitBehavior(), { trapExit: true });
      const serverB = await GenServer.start(createCounterBehavior());
      const serverC = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);
      await GenServer.link(serverA, serverC);

      // Crash both B and C
      GenServer._forceTerminate(serverB, { error: new Error('crash B') });
      GenServer._forceTerminate(serverC, { error: new Error('crash C') });

      // Wait for info messages to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(GenServer.isRunning(serverA)).toBe(true);

      const exitSignals = await GenServer.call(serverA, { type: 'getExitSignals' }) as ExitSignal[];
      expect(exitSignals).toHaveLength(2);
      const fromIds = exitSignals.map((s) => s.from.id);
      expect(fromIds).toContain(serverB.id);
      expect(fromIds).toContain(serverC.id);
    });

    it('only the process with trapExit receives info; other linked process is terminated', async () => {
      const serverA = await GenServer.start(createTrapExitBehavior(), { trapExit: true });
      const serverB = await GenServer.start(createCounterBehavior());
      const serverC = await GenServer.start(createCounterBehavior());

      // A--B--C: A traps exits, C does not
      await GenServer.link(serverA, serverB);
      await GenServer.link(serverB, serverC);

      // Crash B
      GenServer._forceTerminate(serverB, { error: new Error('crash') });

      // A traps: should be running
      expect(GenServer.isRunning(serverA)).toBe(true);
      // C does not trap: should be terminated
      expect(GenServer.isRunning(serverC)).toBe(false);

      // Wait for info message
      await new Promise((resolve) => setTimeout(resolve, 50));

      const exitSignals = await GenServer.call(serverA, { type: 'getExitSignals' }) as ExitSignal[];
      expect(exitSignals).toHaveLength(1);
      expect(exitSignals[0]!.from.id).toBe(serverB.id);
    });

    it('process without handleInfo but with trapExit does not crash', async () => {
      // Behavior with trapExit but no handleInfo defined
      const noHandlerBehavior: GenServerBehavior<number, { type: 'get' }, never, number> = {
        init: () => 0,
        handleCall: (msg, state) => [state, state],
        handleCast: (_msg, state) => state,
        // No handleInfo defined
      };

      const serverA = await GenServer.start(noHandlerBehavior, { trapExit: true });
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      // Crash B - A should survive even without handleInfo
      GenServer._forceTerminate(serverB, { error: new Error('crash') });

      // Wait for potential processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(GenServer.isRunning(serverA)).toBe(true);
    });
  });

  // ===========================================================================
  // Unlink
  // ===========================================================================

  describe('unlink', () => {
    it('prevents exit propagation after unlinking', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      const linkRef = await GenServer.link(serverA, serverB);
      await GenServer.unlink(linkRef);

      // Crash B - A should NOT be affected
      GenServer._forceTerminate(serverB, { error: new Error('crash') });

      expect(GenServer.isRunning(serverA)).toBe(true);
    });

    it('removes link from registry', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      const linkRef = await GenServer.link(serverA, serverB);
      expect(GenServer._getLocalLinkCount()).toBe(1);

      await GenServer.unlink(linkRef);
      expect(GenServer._getLocalLinkCount()).toBe(0);
    });

    it('handles unlink of already-removed link gracefully', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      const linkRef = await GenServer.link(serverA, serverB);
      await GenServer.unlink(linkRef);

      // Second unlink should not throw
      await expect(GenServer.unlink(linkRef)).resolves.toBeUndefined();
    });

    it('only removes the specific link, not others', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());
      const serverC = await GenServer.start(createCounterBehavior());

      const linkAB = await GenServer.link(serverA, serverB);
      await GenServer.link(serverA, serverC);

      expect(GenServer._getLocalLinkCount()).toBe(2);

      // Remove only A-B link
      await GenServer.unlink(linkAB);

      expect(GenServer._getLocalLinkCount()).toBe(1);

      // Crash C - A should still be terminated (link A-C still exists)
      GenServer._forceTerminate(serverC, { error: new Error('crash') });
      expect(GenServer.isRunning(serverA)).toBe(false);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('bidirectional: crash of either side propagates', async () => {
      // Test A crashes -> B terminated
      const serverA1 = await GenServer.start(createCounterBehavior());
      const serverB1 = await GenServer.start(createCounterBehavior());
      await GenServer.link(serverA1, serverB1);
      GenServer._forceTerminate(serverA1, { error: new Error('crash') });
      expect(GenServer.isRunning(serverB1)).toBe(false);

      // Test B crashes -> A terminated (reverse direction)
      const serverA2 = await GenServer.start(createCounterBehavior());
      const serverB2 = await GenServer.start(createCounterBehavior());
      await GenServer.link(serverA2, serverB2);
      GenServer._forceTerminate(serverB2, { error: new Error('crash') });
      expect(GenServer.isRunning(serverA2)).toBe(false);
    });

    it('multiple links to same process pair are independent', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      const link1 = await GenServer.link(serverA, serverB);
      const link2 = await GenServer.link(serverA, serverB);

      expect(GenServer._getLocalLinkCount()).toBe(2);
      expect(link1.linkId).not.toBe(link2.linkId);

      // Remove one link
      await GenServer.unlink(link1);
      expect(GenServer._getLocalLinkCount()).toBe(1);

      // Crash B - A should still be terminated (link2 exists)
      GenServer._forceTerminate(serverB, { error: new Error('crash') });
      expect(GenServer.isRunning(serverA)).toBe(false);
    });

    it('does not double-terminate already stopped process', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());
      const serverC = await GenServer.start(createCounterBehavior());

      // A--B, A--C
      await GenServer.link(serverA, serverB);
      await GenServer.link(serverA, serverC);

      // Stop A normally (no propagation)
      await GenServer.stop(serverA, 'normal');

      // B and C should still be running
      expect(GenServer.isRunning(serverB)).toBe(true);
      expect(GenServer.isRunning(serverC)).toBe(true);
    });

    it('handles concurrent link and stop gracefully', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());

      await GenServer.link(serverA, serverB);

      // Stop both concurrently with normal reason
      await Promise.all([
        GenServer.stop(serverA, 'normal'),
        GenServer.stop(serverB, 'normal'),
      ]);

      expect(GenServer.isRunning(serverA)).toBe(false);
      expect(GenServer.isRunning(serverB)).toBe(false);
      expect(GenServer._getLocalLinkCount()).toBe(0);
    });

    it('link and monitor work independently', async () => {
      const serverA = await GenServer.start(createCounterBehavior());
      const serverB = await GenServer.start(createCounterBehavior());
      const serverC = await GenServer.start(createTrapExitBehavior(), { trapExit: true });

      // C monitors A, C links to B
      await GenServer.monitor(serverC, serverA);
      await GenServer.link(serverC, serverB);

      const events: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => events.push(event));

      // Crash A - C should get process_down (monitor), not be terminated
      GenServer._forceTerminate(serverA, { error: new Error('crash A') });

      // Wait for events
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(GenServer.isRunning(serverC)).toBe(true);

      // Check process_down from monitor
      const processDownEvents = events.filter((e) => e.type === 'process_down');
      expect(processDownEvents.length).toBeGreaterThanOrEqual(1);

      // Crash B - C should get exit signal (link with trapExit)
      GenServer._forceTerminate(serverB, { error: new Error('crash B') });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(GenServer.isRunning(serverC)).toBe(true);

      const exitSignals = await GenServer.call(serverC, { type: 'getExitSignals' }) as ExitSignal[];
      expect(exitSignals).toHaveLength(1);
      expect(exitSignals[0]!.from.id).toBe(serverB.id);
    });
  });
});
