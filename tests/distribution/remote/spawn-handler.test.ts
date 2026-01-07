import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Cluster,
  GenServer,
  NodeId,
  BehaviorRegistry,
  SpawnHandler,
} from '../../../src/index.js';
import type {
  SpawnRequestMessage,
  SpawnReplyMessage,
  SpawnErrorMessage,
  SpawnId,
  NodeId as NodeIdType,
} from '../../../src/index.js';
import type { GenServerBehavior } from '../../../src/index.js';

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

// Failing init behavior for testing error handling
const failingInitBehavior: GenServerBehavior<number, unknown, unknown, unknown> = {
  init: () => {
    throw new Error('Init failed intentionally');
  },
  handleCall: (_msg, state) => [state, state],
  handleCast: (_msg, state) => state,
};

// Helper to create spawn request messages
function createSpawnRequest(
  behaviorName: string,
  options: {
    name?: string;
    initTimeout?: number;
    registration?: 'local' | 'global' | 'none';
  } = {},
): SpawnRequestMessage {
  return {
    type: 'spawn_request',
    spawnId: `s${Date.now()}-${Math.random().toString(16).slice(2)}` as SpawnId,
    behaviorName,
    options: {
      ...(options.name !== undefined && { name: options.name }),
      ...(options.initTimeout !== undefined && { initTimeout: options.initTimeout }),
      ...(options.registration !== undefined && { registration: options.registration }),
    },
    timeoutMs: 10000,
    sentAt: Date.now(),
  };
}

describe('SpawnHandler', () => {
  beforeEach(async () => {
    await safeStopCluster();
    BehaviorRegistry._clear();
  });

  afterEach(async () => {
    BehaviorRegistry._clear();
    await safeStopCluster();
    // Clean up any lingering GenServers
    await GenServer._stopAll?.();
  });

  describe('handleIncomingSpawn', () => {
    it('returns error when behavior is not registered', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      const fromNodeId = NodeId.parse('remote@127.0.0.1:9999');
      const message = createSpawnRequest('non-existent-behavior');

      let receivedReply: SpawnReplyMessage | SpawnErrorMessage | null = null;

      await SpawnHandler.handleIncomingSpawn(
        message,
        fromNodeId,
        async (reply) => {
          receivedReply = reply;
        },
      );

      expect(receivedReply).not.toBeNull();
      expect(receivedReply!.type).toBe('spawn_error');
      const errorReply = receivedReply as SpawnErrorMessage;
      expect(errorReply.errorType).toBe('behavior_not_found');
      expect(errorReply.spawnId).toBe(message.spawnId);
    });

    it('successfully spawns a registered behavior', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      // Register the behavior
      BehaviorRegistry.register('counter', counterBehavior);

      const fromNodeId = NodeId.parse('remote@127.0.0.1:9999');
      const message = createSpawnRequest('counter');

      let receivedReply: SpawnReplyMessage | SpawnErrorMessage | null = null;

      await SpawnHandler.handleIncomingSpawn(
        message,
        fromNodeId,
        async (reply) => {
          receivedReply = reply;
        },
      );

      expect(receivedReply).not.toBeNull();
      expect(receivedReply!.type).toBe('spawn_reply');

      const successReply = receivedReply as SpawnReplyMessage;
      expect(successReply.spawnId).toBe(message.spawnId);
      expect(successReply.serverId).toBeDefined();
      expect(typeof successReply.serverId).toBe('string');
      expect(successReply.nodeId).toBe(Cluster.getLocalNodeId());
    });

    it('spawns with name option', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      BehaviorRegistry.register('counter', counterBehavior);

      const fromNodeId = NodeId.parse('remote@127.0.0.1:9999');
      const message = createSpawnRequest('counter', { name: 'my-counter' });

      let receivedReply: SpawnReplyMessage | SpawnErrorMessage | null = null;

      await SpawnHandler.handleIncomingSpawn(
        message,
        fromNodeId,
        async (reply) => {
          receivedReply = reply;
        },
      );

      expect(receivedReply).not.toBeNull();
      expect(receivedReply!.type).toBe('spawn_reply');
    });

    it('handles init failure', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      // Register the failing behavior
      BehaviorRegistry.register('failing', failingInitBehavior);

      const fromNodeId = NodeId.parse('remote@127.0.0.1:9999');
      const message = createSpawnRequest('failing');

      let receivedReply: SpawnReplyMessage | SpawnErrorMessage | null = null;

      await SpawnHandler.handleIncomingSpawn(
        message,
        fromNodeId,
        async (reply) => {
          receivedReply = reply;
        },
      );

      expect(receivedReply).not.toBeNull();
      expect(receivedReply!.type).toBe('spawn_error');

      const errorReply = receivedReply as SpawnErrorMessage;
      expect(errorReply.spawnId).toBe(message.spawnId);
      expect(errorReply.errorType).toBe('init_failed');
      expect(errorReply.message).toContain('Init failed intentionally');
    });

    it('spawned server is callable', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      BehaviorRegistry.register('counter', counterBehavior);

      const fromNodeId = NodeId.parse('remote@127.0.0.1:9999');
      const message = createSpawnRequest('counter');

      let receivedReply: SpawnReplyMessage | SpawnErrorMessage | null = null;

      await SpawnHandler.handleIncomingSpawn(
        message,
        fromNodeId,
        async (reply) => {
          receivedReply = reply;
        },
      );

      expect(receivedReply!.type).toBe('spawn_reply');
      const successReply = receivedReply as SpawnReplyMessage;

      // Get the server ref and verify it's running
      const ref = GenServer._getRefById(successReply.serverId);
      expect(ref).toBeDefined();
      expect(GenServer.isRunning(ref!)).toBe(true);

      // Call the server
      const count = await GenServer.call(ref!, { type: 'get' });
      expect(count).toBe(0);

      // Increment and verify
      const newCount = await GenServer.call(ref!, { type: 'increment' });
      expect(newCount).toBe(1);
    });

    it('handles multiple spawn requests', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'local', port });

      BehaviorRegistry.register('counter', counterBehavior);

      const fromNodeId = NodeId.parse('remote@127.0.0.1:9999');
      const replies: (SpawnReplyMessage | SpawnErrorMessage)[] = [];

      // Spawn multiple servers
      for (let i = 0; i < 3; i++) {
        const message = createSpawnRequest('counter');
        await SpawnHandler.handleIncomingSpawn(
          message,
          fromNodeId,
          async (reply) => {
            replies.push(reply);
          },
        );
      }

      expect(replies).toHaveLength(3);

      // All should be successful with different server IDs
      const serverIds = new Set<string>();
      for (const reply of replies) {
        expect(reply.type).toBe('spawn_reply');
        const successReply = reply as SpawnReplyMessage;
        serverIds.add(successReply.serverId);
      }

      expect(serverIds.size).toBe(3); // All unique server IDs
    });
  });
});

describe('SpawnHandler error type classification', () => {
  beforeEach(async () => {
    await safeStopCluster();
    BehaviorRegistry._clear();
  });

  afterEach(async () => {
    BehaviorRegistry._clear();
    await safeStopCluster();
  });

  it('returns behavior_not_found for unregistered behaviors', async () => {
    const port = getNextPort();
    await Cluster.start({ nodeName: 'local', port });

    const message = createSpawnRequest('unknown');
    let errorType: string | null = null;

    await SpawnHandler.handleIncomingSpawn(
      message,
      NodeId.parse('remote@127.0.0.1:9999'),
      async (reply) => {
        if (reply.type === 'spawn_error') {
          errorType = reply.errorType;
        }
      },
    );

    expect(errorType).toBe('behavior_not_found');
  });

  it('returns init_failed for behaviors that throw during init', async () => {
    const port = getNextPort();
    await Cluster.start({ nodeName: 'local', port });

    BehaviorRegistry.register('failing', failingInitBehavior);

    const message = createSpawnRequest('failing');
    let errorType: string | null = null;

    await SpawnHandler.handleIncomingSpawn(
      message,
      NodeId.parse('remote@127.0.0.1:9999'),
      async (reply) => {
        if (reply.type === 'spawn_error') {
          errorType = reply.errorType;
        }
      },
    );

    expect(errorType).toBe('init_failed');
  });
});

describe('SpawnHandler with registration options', () => {
  beforeEach(async () => {
    await safeStopCluster();
    BehaviorRegistry._clear();
  });

  afterEach(async () => {
    BehaviorRegistry._clear();
    await safeStopCluster();
  });

  it('handles local registration option', async () => {
    const port = getNextPort();
    await Cluster.start({ nodeName: 'local', port });

    BehaviorRegistry.register('counter', counterBehavior);

    const message = createSpawnRequest('counter', {
      name: 'local-counter',
      registration: 'local',
    });

    let reply: SpawnReplyMessage | SpawnErrorMessage | null = null;

    await SpawnHandler.handleIncomingSpawn(
      message,
      NodeId.parse('remote@127.0.0.1:9999'),
      async (r) => {
        reply = r;
      },
    );

    expect(reply!.type).toBe('spawn_reply');
  });

  it('handles none registration option', async () => {
    const port = getNextPort();
    await Cluster.start({ nodeName: 'local', port });

    BehaviorRegistry.register('counter', counterBehavior);

    const message = createSpawnRequest('counter', {
      name: 'unnamed-counter',
      registration: 'none',
    });

    let reply: SpawnReplyMessage | SpawnErrorMessage | null = null;

    await SpawnHandler.handleIncomingSpawn(
      message,
      NodeId.parse('remote@127.0.0.1:9999'),
      async (r) => {
        reply = r;
      },
    );

    expect(reply!.type).toBe('spawn_reply');
  });
});
