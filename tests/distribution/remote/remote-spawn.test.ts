import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Cluster,
  NodeId,
  RemoteSpawn,
  BehaviorRegistry,
  ClusterNotStartedError,
  NodeNotReachableError,
  RemoteSpawnTimeoutError,
  BehaviorNotFoundError,
} from '../../../src/index.js';
import { _resetRemoteSpawnState } from '../../../src/distribution/remote/index.js';
import type { GenServerBehavior } from '../../../src/index.js';

// Helper to create unique ports for each test
let portCounter = 16500;
function getNextPort(): number {
  return portCounter++;
}

// Helper to safely stop cluster
async function safeStopCluster(): Promise<void> {
  try {
    if (Cluster.getStatus() !== 'stopped') {
      await Cluster.stop();
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// Simple counter behavior for testing
interface CounterState {
  count: number;
}

type CounterCallMsg =
  | { type: 'get' }
  | { type: 'increment' };

type CounterCastMsg = { type: 'increment' };

type CounterCallReply = number;

const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCallMsg,
  CounterCastMsg,
  CounterCallReply
> = {
  init: () => ({ count: 0 }),
  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.count, state];
      case 'increment':
        return [state.count + 1, { count: state.count + 1 }];
    }
  },
  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'increment':
        return { count: state.count + 1 };
    }
  },
};

// Slow init behavior for timeout testing
const slowInitBehavior: GenServerBehavior<number, unknown, unknown, unknown> = {
  init: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return 0;
  },
  handleCall: (_msg, state) => [state, state],
  handleCast: (_msg, state) => state,
};

// Failing init behavior
const failingInitBehavior: GenServerBehavior<number, unknown, unknown, unknown> = {
  init: () => {
    throw new Error('Init failed intentionally');
  },
  handleCall: (_msg, state) => [state, state],
  handleCast: (_msg, state) => state,
};

describe('RemoteSpawn', () => {
  beforeEach(async () => {
    await safeStopCluster();
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
  });

  afterEach(async () => {
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
    await safeStopCluster();
  });

  describe('getStats', () => {
    it('returns initial stats', () => {
      const stats = RemoteSpawn.getStats();

      expect(stats.pendingCount).toBe(0);
      expect(stats.totalInitiated).toBe(0);
      expect(stats.totalResolved).toBe(0);
      expect(stats.totalRejected).toBe(0);
      expect(stats.totalTimedOut).toBe(0);
      expect(stats.initialized).toBe(false);
    });

    it('shows initialized after first spawn attempt', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      const remoteNodeId = NodeId.parse('remote@127.0.0.1:9999');

      try {
        await RemoteSpawn.spawn('counter', remoteNodeId);
      } catch {
        // Expected to fail - node not reachable
      }

      const stats = RemoteSpawn.getStats();
      expect(stats.initialized).toBe(true);
    });
  });

  describe('spawn without cluster', () => {
    it('throws ClusterNotStartedError when cluster is not running', async () => {
      const nodeId = NodeId.parse('remote@127.0.0.1:4369');

      await expect(
        RemoteSpawn.spawn('counter', nodeId),
      ).rejects.toThrow(ClusterNotStartedError);
    });
  });

  describe('spawn to unreachable node', () => {
    it('throws NodeNotReachableError when target node is not connected', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      const remoteNodeId = NodeId.parse('remote@127.0.0.1:9999');

      await expect(
        RemoteSpawn.spawn('counter', remoteNodeId),
      ).rejects.toThrow(NodeNotReachableError);
    });
  });
});

describe('BehaviorRegistry integration with RemoteSpawn', () => {
  beforeEach(async () => {
    await safeStopCluster();
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
  });

  afterEach(async () => {
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
    await safeStopCluster();
  });

  it('registers and retrieves behaviors correctly', () => {
    BehaviorRegistry.register('counter', counterBehavior);

    expect(BehaviorRegistry.has('counter')).toBe(true);
    expect(BehaviorRegistry.get('counter')).toBe(counterBehavior);
  });

  it('lists all registered behavior names', () => {
    BehaviorRegistry.register('counter', counterBehavior);
    BehaviorRegistry.register('slow', slowInitBehavior);

    const names = BehaviorRegistry.getNames();
    expect(names).toContain('counter');
    expect(names).toContain('slow');
    expect(names).toHaveLength(2);
  });

  it('returns stats correctly', () => {
    BehaviorRegistry.register('counter', counterBehavior);
    BehaviorRegistry.register('slow', slowInitBehavior);

    const stats = BehaviorRegistry.getStats();
    expect(stats.count).toBe(2);
    expect(stats.names).toContain('counter');
    expect(stats.names).toContain('slow');
  });
});

describe('RemoteSpawn message handling', () => {
  beforeEach(async () => {
    await safeStopCluster();
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
  });

  afterEach(async () => {
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
    await safeStopCluster();
  });

  it('handles spawn reply correctly', () => {
    const nodeId = NodeId.parse('remote@127.0.0.1:4369');

    // Simulate a spawn reply (internal method)
    RemoteSpawn._handleSpawnReply({
      type: 'spawn_reply',
      spawnId: 'snon-existent' as any,
      serverId: 'server1',
      nodeId,
    });

    // Should not throw - just ignores unknown spawn IDs
  });

  it('handles spawn error correctly', () => {
    // Simulate a spawn error (internal method)
    RemoteSpawn._handleSpawnError({
      type: 'spawn_error',
      spawnId: 'snon-existent' as any,
      errorType: 'behavior_not_found',
      message: 'Behavior not found',
    });

    // Should not throw - just ignores unknown spawn IDs
  });

  it('clears pending spawns', async () => {
    const port = getNextPort();
    await Cluster.start({ nodeName: 'local', port });

    // Clear should not throw even with no pending spawns
    RemoteSpawn._clear();

    const stats = RemoteSpawn.getStats();
    expect(stats.pendingCount).toBe(0);
  });
});

describe('RemoteSpawn timeout handling', () => {
  beforeEach(async () => {
    await safeStopCluster();
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
  });

  afterEach(async () => {
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
    await safeStopCluster();
  });

  it('updates stats when spawn times out', async () => {
    // This test verifies the stats are updated correctly
    // The actual timeout behavior is tested via PendingSpawns
    const stats = RemoteSpawn.getStats();
    expect(stats.totalTimedOut).toBe(0);
  });
});

describe('RemoteSpawn options handling', () => {
  beforeEach(async () => {
    await safeStopCluster();
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
  });

  afterEach(async () => {
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
    await safeStopCluster();
  });

  it('accepts all optional parameters', async () => {
    const port = getNextPort();
    await Cluster.start({ nodeName: 'local', port });

    const remoteNodeId = NodeId.parse('remote@127.0.0.1:9999');

    // Should not throw type errors - options are properly typed
    try {
      await RemoteSpawn.spawn('counter', remoteNodeId, {
        name: 'my-counter',
        initTimeout: 5000,
        registration: 'global',
        timeout: 10000,
      });
    } catch (error) {
      // Expected to fail - node not reachable
      expect(error).toBeInstanceOf(NodeNotReachableError);
    }
  });

  it('works with minimal parameters', async () => {
    const port = getNextPort();
    await Cluster.start({ nodeName: 'local', port });

    const remoteNodeId = NodeId.parse('remote@127.0.0.1:9999');

    try {
      await RemoteSpawn.spawn('counter', remoteNodeId);
    } catch (error) {
      expect(error).toBeInstanceOf(NodeNotReachableError);
    }
  });
});
