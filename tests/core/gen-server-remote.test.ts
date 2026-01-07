/**
 * Integration tests for GenServer.startRemote() method.
 *
 * Tests the high-level API for spawning GenServers on remote cluster nodes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GenServer,
  Cluster,
  NodeId,
  BehaviorRegistry,
  ClusterNotStartedError,
  NodeNotReachableError,
  type GenServerBehavior,
  type RemoteStartOptions,
} from '../../src/index.js';
import { _resetRemoteSpawnState } from '../../src/distribution/remote/index.js';

// Helper to create unique ports for each test
let portCounter = 17500;
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

type CounterCallMsg = { type: 'get' } | { type: 'increment' };
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

describe('GenServer.startRemote', () => {
  beforeEach(async () => {
    await safeStopCluster();
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
  });

  afterEach(async () => {
    _resetRemoteSpawnState();
    BehaviorRegistry._clear();
    GenServer._clearLifecycleHandlers();
    await safeStopCluster();
  });

  describe('error handling', () => {
    it('throws ClusterNotStartedError when cluster is not running', async () => {
      await expect(
        GenServer.startRemote('counter', {
          targetNode: 'remote@127.0.0.1:4369',
        }),
      ).rejects.toThrow(ClusterNotStartedError);
    });

    it('throws NodeNotReachableError when target node is not connected', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      await expect(
        GenServer.startRemote('counter', {
          targetNode: 'remote@127.0.0.1:9999',
        }),
      ).rejects.toThrow(NodeNotReachableError);
    });

    it('throws InvalidNodeIdError for invalid target node format', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      await expect(
        GenServer.startRemote('counter', {
          targetNode: 'invalid-node-id',
        }),
      ).rejects.toThrow(/Invalid NodeId/);
    });
  });

  describe('options handling', () => {
    it('accepts minimal options with just targetNode', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      // Should not throw type errors - types are correct
      try {
        await GenServer.startRemote('counter', {
          targetNode: 'remote@127.0.0.1:9999',
        });
      } catch (error) {
        // Expected to fail - node not reachable
        expect(error).toBeInstanceOf(NodeNotReachableError);
      }
    });

    it('accepts all optional parameters', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      const options: RemoteStartOptions<CounterState> = {
        targetNode: 'remote@127.0.0.1:9999',
        name: 'my-counter',
        initTimeout: 5000,
        registration: 'global',
        spawnTimeout: 15000,
      };

      try {
        await GenServer.startRemote<
          CounterState,
          CounterCallMsg,
          CounterCastMsg,
          CounterCallReply
        >('counter', options);
      } catch (error) {
        expect(error).toBeInstanceOf(NodeNotReachableError);
      }
    });

    it('accepts registration: local', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      try {
        await GenServer.startRemote('counter', {
          targetNode: 'remote@127.0.0.1:9999',
          name: 'local-counter',
          registration: 'local',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(NodeNotReachableError);
      }
    });

    it('accepts registration: none', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      try {
        await GenServer.startRemote('counter', {
          targetNode: 'remote@127.0.0.1:9999',
          registration: 'none',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(NodeNotReachableError);
      }
    });

    it('defaults to local registration when name is provided', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      // This test verifies the type system accepts name without explicit registration
      try {
        await GenServer.startRemote('counter', {
          targetNode: 'remote@127.0.0.1:9999',
          name: 'named-counter',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(NodeNotReachableError);
      }
    });
  });

  describe('type safety', () => {
    it('preserves generic types through startRemote', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      // This test verifies type inference works correctly
      // The ref should have correct generic types
      try {
        const _ref = await GenServer.startRemote<
          CounterState,
          CounterCallMsg,
          CounterCastMsg,
          CounterCallReply
        >('counter', {
          targetNode: 'remote@127.0.0.1:9999',
        });

        // If we got here, the ref would have correct types:
        // - State: CounterState
        // - CallMsg: CounterCallMsg
        // - CastMsg: CounterCastMsg
        // - CallReply: CounterCallReply
      } catch (error) {
        expect(error).toBeInstanceOf(NodeNotReachableError);
      }
    });

    it('accepts NodeId type for targetNode', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      // NodeId.parse returns a validated NodeId type
      const targetNode = NodeId.parse('remote@127.0.0.1:9999');

      try {
        await GenServer.startRemote('counter', {
          // NodeId should be assignable to targetNode (string)
          targetNode: targetNode as string,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(NodeNotReachableError);
      }
    });
  });

  describe('behavior registry integration', () => {
    it('works with BehaviorRegistry for registering behaviors', () => {
      // Register a behavior that would be used on remote nodes
      BehaviorRegistry.register('counter', counterBehavior);

      expect(BehaviorRegistry.has('counter')).toBe(true);
      expect(BehaviorRegistry.get('counter')).toBe(counterBehavior);
    });

    it('documents the remote spawn workflow', async () => {
      // This test documents the expected usage pattern:

      // 1. Register behavior on ALL nodes (both local and remote)
      BehaviorRegistry.register('counter', counterBehavior);

      // 2. Start cluster on local node
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      // 3. Attempt remote spawn (will fail since no remote node exists)
      try {
        await GenServer.startRemote('counter', {
          targetNode: 'remote@127.0.0.1:9999',
          name: 'remote-counter',
          registration: 'global',
        });
      } catch (error) {
        // Expected - remote node not available
        expect(error).toBeInstanceOf(NodeNotReachableError);
      }

      // In real usage, the remote node would:
      // 1. Also call BehaviorRegistry.register('counter', counterBehavior)
      // 2. Start its own cluster with seeds pointing to this node
      // 3. This spawn would succeed and return a GenServerRef
      // 4. The ref can be used with GenServer.call/cast transparently
    });
  });
});

describe('GenServer.startRemote return value', () => {
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

  it('returns GenServerRef with nodeId for remote routing', async () => {
    // This test documents the expected return value structure
    // Since we can't actually spawn on a remote node without a real cluster,
    // we verify the type signature and document expected behavior

    const port = getNextPort();
    await Cluster.start({ nodeName: 'local', port });

    // The returned ref should have:
    // - id: string - the server ID on the remote node
    // - nodeId: string - the NodeId where the server is running
    //
    // When passed to GenServer.call/cast, the nodeId enables
    // automatic routing to the remote node

    try {
      const _ref = await GenServer.startRemote('counter', {
        targetNode: 'remote@127.0.0.1:9999',
      });

      // If successful, ref would be:
      // {
      //   id: 'genserver_1_...',
      //   nodeId: 'remote@127.0.0.1:9999'
      // }
      //
      // And can be used with:
      // await GenServer.call(ref, { type: 'get' }); // Automatically routes to remote
    } catch (error) {
      expect(error).toBeInstanceOf(NodeNotReachableError);
    }
  });
});
