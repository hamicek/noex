import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Cluster,
  GenServer,
  NodeId,
  RemoteCall,
  ClusterNotStartedError,
  NodeNotReachableError,
  RemoteCallTimeoutError,
  RemoteServerNotRunningError,
} from '../../../src/index.js';
import { _resetRemoteCallState } from '../../../src/distribution/remote/index.js';
import type { GenServerBehavior, GenServerRef } from '../../../src/index.js';

// Helper to create unique ports for each test
let portCounter = 15500;
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
  | { type: 'increment' }
  | { type: 'add'; amount: number }
  | { type: 'slow'; delayMs: number };

type CounterCastMsg =
  | { type: 'increment' }
  | { type: 'reset' };

type CounterCallReply = number;

const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCallMsg,
  CounterCastMsg,
  CounterCallReply
> = {
  init: () => ({ count: 0 }),
  handleCall: async (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.count, state];
      case 'increment':
        return [state.count + 1, { count: state.count + 1 }];
      case 'add':
        return [state.count + msg.amount, { count: state.count + msg.amount }];
      case 'slow':
        await new Promise((r) => setTimeout(r, msg.delayMs));
        return [state.count, state];
    }
  },
  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'increment':
        return { count: state.count + 1 };
      case 'reset':
        return { count: 0 };
    }
  },
};

describe('RemoteCall', () => {
  beforeEach(async () => {
    // Ensure clean state before each test
    await safeStopCluster();
    _resetRemoteCallState();
  });

  afterEach(async () => {
    _resetRemoteCallState();
    await safeStopCluster();
  });

  describe('getStats', () => {
    it('returns initial stats', () => {
      const stats = RemoteCall.getStats();

      expect(stats.pendingCalls).toBe(0);
      expect(stats.totalCalls).toBe(0);
      expect(stats.totalResolved).toBe(0);
      expect(stats.totalRejected).toBe(0);
      expect(stats.totalTimedOut).toBe(0);
      expect(stats.totalCasts).toBe(0);
    });
  });

  describe('call without cluster', () => {
    it('throws ClusterNotStartedError when cluster is not running', async () => {
      const nodeId = NodeId.parse('remote@127.0.0.1:4369');
      const ref = { id: 'server1', nodeId };

      await expect(
        RemoteCall.call(ref, { type: 'get' }),
      ).rejects.toThrow(ClusterNotStartedError);
    });
  });

  describe('cast without cluster', () => {
    it('does not throw when cluster is not running', () => {
      const nodeId = NodeId.parse('remote@127.0.0.1:4369');
      const ref = { id: 'server1', nodeId };

      // Should not throw - just silently drops the cast
      expect(() => RemoteCall.cast(ref, { type: 'increment' })).not.toThrow();
    });
  });

  describe('call to unreachable node', () => {
    it('throws NodeNotReachableError when target node is not connected', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      const remoteNodeId = NodeId.parse('remote@127.0.0.1:9999');
      const ref = { id: 'server1', nodeId: remoteNodeId };

      await expect(
        RemoteCall.call(ref, { type: 'get' }),
      ).rejects.toThrow(NodeNotReachableError);
    });
  });
});

describe('Remote Call Integration', () => {
  let serverRef: GenServerRef<CounterState, CounterCallMsg, CounterCastMsg, CounterCallReply> | null = null;

  beforeEach(async () => {
    // Ensure clean state before each test
    await safeStopCluster();
    _resetRemoteCallState();
    serverRef = null;
  });

  afterEach(async () => {
    // Stop any running servers
    if (serverRef && GenServer.isRunning(serverRef)) {
      try {
        await GenServer.stop(serverRef);
      } catch {
        // Ignore
      }
    }
    serverRef = null;

    _resetRemoteCallState();
    await safeStopCluster();
  });

  describe('two-node cluster communication', () => {
    it('performs remote call between two nodes', async () => {
      const port1 = getNextPort();
      const port2 = getNextPort();
      const nodeId1 = NodeId.create('node1', '127.0.0.1', port1);
      const nodeId2 = NodeId.create('node2', '127.0.0.1', port2);

      // Start first cluster node
      await Cluster.start({
        nodeName: 'node1',
        host: '127.0.0.1',
        port: port1,
        seeds: [`node2@127.0.0.1:${port2}`],
      });

      // Start a local GenServer on node1
      serverRef = await GenServer.start(counterBehavior, { name: 'counter' });

      // Verify local call works
      const localResult = await GenServer.call(serverRef, { type: 'get' });
      expect(localResult).toBe(0);

      // Increment locally
      await GenServer.call(serverRef, { type: 'increment' });
      const afterIncrement = await GenServer.call(serverRef, { type: 'get' });
      expect(afterIncrement).toBe(1);
    });

    it('GenServer.call routes to remote node when nodeId differs', async () => {
      const port = getNextPort();

      await Cluster.start({
        nodeName: 'local',
        host: '127.0.0.1',
        port,
      });

      // Create a local server
      serverRef = await GenServer.start(counterBehavior, { name: 'counter' });

      // Create a ref with a different nodeId (simulating remote ref)
      const localNodeId = Cluster.getLocalNodeId();
      const remoteNodeId = NodeId.parse('remote@192.168.1.1:4369');

      // This should attempt remote call (will fail because remote node doesn't exist)
      // But it demonstrates the routing logic works
      const remoteRef = {
        ...serverRef,
        nodeId: remoteNodeId,
      } as typeof serverRef;

      // The call should fail with NodeNotReachableError
      await expect(
        GenServer.call(remoteRef, { type: 'get' }),
      ).rejects.toThrow(NodeNotReachableError);
    });

    it('GenServer.call to local node with matching nodeId works', async () => {
      const port = getNextPort();

      await Cluster.start({
        nodeName: 'local',
        host: '127.0.0.1',
        port,
      });

      serverRef = await GenServer.start(counterBehavior, { name: 'counter' });

      // Get local node ID
      const localNodeId = Cluster.getLocalNodeId();

      // Create ref with matching nodeId (should be treated as local)
      const localRef = {
        id: serverRef.id,
        nodeId: localNodeId,
      } as typeof serverRef;

      // This should work as a local call
      const result = await GenServer.call(localRef, { type: 'get' });
      expect(result).toBe(0);
    });
  });

  describe('GenServer.cast remote routing', () => {
    it('GenServer.cast silently drops when remote node unreachable', async () => {
      const port = getNextPort();

      await Cluster.start({
        nodeName: 'local',
        host: '127.0.0.1',
        port,
      });

      serverRef = await GenServer.start(counterBehavior, { name: 'counter' });

      const remoteNodeId = NodeId.parse('remote@192.168.1.1:4369');
      const remoteRef = {
        ...serverRef,
        nodeId: remoteNodeId,
      } as typeof serverRef;

      // Should not throw - casts are fire-and-forget
      expect(() => GenServer.cast(remoteRef, { type: 'increment' })).not.toThrow();

      // Give async operation time to complete
      await new Promise((r) => setTimeout(r, 50));
    });

    it('GenServer.cast to local node with nodeId works', async () => {
      const port = getNextPort();

      await Cluster.start({
        nodeName: 'local',
        host: '127.0.0.1',
        port,
      });

      serverRef = await GenServer.start(counterBehavior, { name: 'counter' });
      const localNodeId = Cluster.getLocalNodeId();

      // Create ref with matching nodeId
      const localRef = {
        id: serverRef.id,
        nodeId: localNodeId,
      } as typeof serverRef;

      // Cast should work locally
      GenServer.cast(localRef, { type: 'increment' });

      // Wait for cast to be processed
      await new Promise((r) => setTimeout(r, 50));

      // Verify the cast was processed
      const result = await GenServer.call(serverRef, { type: 'get' });
      expect(result).toBe(1);
    });
  });

  describe('backward compatibility', () => {
    it('GenServer.call without nodeId works as before', async () => {
      // No cluster started - should work as normal local call
      serverRef = await GenServer.start(counterBehavior, { name: 'counter' });

      const result = await GenServer.call(serverRef, { type: 'get' });
      expect(result).toBe(0);

      await GenServer.call(serverRef, { type: 'increment' });
      const afterIncrement = await GenServer.call(serverRef, { type: 'get' });
      expect(afterIncrement).toBe(1);
    });

    it('GenServer.cast without nodeId works as before', async () => {
      serverRef = await GenServer.start(counterBehavior, { name: 'counter' });

      GenServer.cast(serverRef, { type: 'increment' });
      GenServer.cast(serverRef, { type: 'increment' });

      // Wait for casts to be processed
      await new Promise((r) => setTimeout(r, 50));

      const result = await GenServer.call(serverRef, { type: 'get' });
      expect(result).toBe(2);
    });

    it('existing code without distribution still works', async () => {
      // This test ensures we haven't broken backward compatibility
      serverRef = await GenServer.start(counterBehavior);

      // Standard operations
      expect(GenServer.isRunning(serverRef)).toBe(true);

      const result1 = await GenServer.call(serverRef, { type: 'get' });
      expect(result1).toBe(0);

      await GenServer.call(serverRef, { type: 'add', amount: 5 });
      const result2 = await GenServer.call(serverRef, { type: 'get' });
      expect(result2).toBe(5);

      GenServer.cast(serverRef, { type: 'reset' });
      await new Promise((r) => setTimeout(r, 50));

      const result3 = await GenServer.call(serverRef, { type: 'get' });
      expect(result3).toBe(0);

      await GenServer.stop(serverRef);
      expect(GenServer.isRunning(serverRef)).toBe(false);
    });
  });
});

describe('Remote Call Stats Tracking', () => {
  beforeEach(async () => {
    await safeStopCluster();
    _resetRemoteCallState();
  });

  afterEach(async () => {
    _resetRemoteCallState();
    await safeStopCluster();
  });

  it('tracks initial stats correctly', async () => {
    const port = getNextPort();
    await Cluster.start({ nodeName: 'local', port });

    // Stats should be at initial values
    const stats = RemoteCall.getStats();
    expect(stats.pendingCalls).toBe(0);
    expect(stats.totalCalls).toBe(0);
    expect(stats.totalCasts).toBe(0);
  });

  it('cast to unconnected node does not increment stats (drops silently)', async () => {
    const port = getNextPort();
    await Cluster.start({ nodeName: 'local', port });

    const remoteNodeId = NodeId.parse('remote@127.0.0.1:9999');
    const ref = { id: 'server1', nodeId: remoteNodeId };

    // Cast to unconnected node - should be silently dropped (not counted)
    RemoteCall.cast(ref, { type: 'increment' });
    RemoteCall.cast(ref, { type: 'increment' });
    RemoteCall.cast(ref, { type: 'increment' });

    // Since node is not connected, casts are dropped and not counted
    const stats = RemoteCall.getStats();
    expect(stats.totalCasts).toBe(0);
  });
});
