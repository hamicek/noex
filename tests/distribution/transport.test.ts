import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Transport,
  NodeId,
  Serializer,
  ClusterNotStartedError,
  InvalidClusterConfigError,
} from '../../src/index.js';
import type {
  TransportState,
  HeartbeatMessage,
  CastMessage,
  MessageEnvelope,
} from '../../src/index.js';

describe('Transport', () => {
  const nodeId1 = NodeId.parse('node1@127.0.0.1:4371');
  const nodeId2 = NodeId.parse('node2@127.0.0.1:4372');
  const nodeId3 = NodeId.parse('node3@127.0.0.1:4373');

  let transport1: Transport | null = null;
  let transport2: Transport | null = null;
  let transport3: Transport | null = null;

  beforeEach(() => {
    transport1 = null;
    transport2 = null;
    transport3 = null;
  });

  afterEach(async () => {
    const cleanups = [transport1, transport2, transport3]
      .filter((t): t is Transport => t !== null)
      .map((t) => t.stop().catch(() => {}));

    await Promise.all(cleanups);
  });

  describe('constructor', () => {
    it('creates transport with minimal configuration', () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
      });

      expect(transport1.getState()).toBe('stopped');
      expect(transport1.getLocalNodeId()).toBe(nodeId1);
    });

    it('creates transport with full configuration', () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        host: '127.0.0.1',
        port: 4371,
        clusterSecret: 'test-secret',
        reconnectBaseDelayMs: 500,
        reconnectMaxDelayMs: 5000,
        connectTimeoutMs: 3000,
      });

      expect(transport1.getState()).toBe('stopped');
    });

    it('throws when localNodeId is missing', () => {
      expect(() => {
        new Transport({} as any);
      }).toThrow(InvalidClusterConfigError);
    });
  });

  describe('getStats', () => {
    it('returns initial statistics', () => {
      transport1 = new Transport({ localNodeId: nodeId1 });

      const stats = transport1.getStats();

      expect(stats.state).toBe('stopped');
      expect(stats.localNodeId).toBe(nodeId1);
      expect(stats.listeningPort).toBeNull();
      expect(stats.activeConnections).toBe(0);
      expect(stats.totalMessagesSent).toBe(0);
      expect(stats.totalMessagesReceived).toBe(0);
      expect(stats.connections.size).toBe(0);
    });
  });

  describe('start', () => {
    it('starts transport and begins listening', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });

      const startedPromise = new Promise<number>((resolve) => {
        transport1!.on('started', (port) => resolve(port));
      });

      await transport1.start();

      const port = await startedPromise;
      expect(port).toBe(4371);
      expect(transport1.getState()).toBe('running');
      expect(transport1.getListeningPort()).toBe(4371);
    });

    it('returns immediately if already running', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });

      await transport1.start();
      await transport1.start(); // Should return immediately

      expect(transport1.getState()).toBe('running');
    });

    it('rejects if trying to start while stopping', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });

      await transport1.start();

      // Start stopping (don't await)
      const stopPromise = transport1.stop();

      await expect(transport1.start()).rejects.toThrow();

      await stopPromise;
    });

    it('uses port from nodeId if not specified', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        // port not specified, should use 4371 from nodeId1
      });

      await transport1.start();

      expect(transport1.getListeningPort()).toBe(4371);
    });
  });

  describe('stop', () => {
    it('stops the transport and closes all connections', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });

      await transport1.start();
      await transport2.start();
      await transport1.connectTo(nodeId2);

      const stoppedPromise = new Promise<void>((resolve) => {
        transport1!.on('stopped', () => resolve());
      });

      await transport1.stop();
      await stoppedPromise;

      expect(transport1.getState()).toBe('stopped');
      expect(transport1.getListeningPort()).toBeNull();
      expect(transport1.getConnectedNodes().length).toBe(0);
    });

    it('returns immediately if already stopped', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
      });

      await transport1.stop();
      expect(transport1.getState()).toBe('stopped');
    });

    it('waits for ongoing stop if stopping', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });

      await transport1.start();

      // Start two stops simultaneously
      const [, ] = await Promise.all([
        transport1.stop(),
        transport1.stop(),
      ]);

      expect(transport1.getState()).toBe('stopped');
    });
  });

  describe('connectTo', () => {
    it('establishes connection to another transport', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });

      await transport1.start();
      await transport2.start();

      const connectedPromise = new Promise<void>((resolve) => {
        transport1!.on('connectionEstablished', (nodeId) => {
          if (nodeId === nodeId2) resolve();
        });
      });

      await transport1.connectTo(nodeId2);
      await connectedPromise;

      expect(transport1.isConnectedTo(nodeId2)).toBe(true);
      expect(transport1.getConnectedNodes()).toContain(nodeId2);
    });

    it('does not connect to self', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });

      await transport1.start();
      await transport1.connectTo(nodeId1);

      expect(transport1.isConnectedTo(nodeId1)).toBe(false);
    });

    it('returns immediately if already connected', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });

      await transport1.start();
      await transport2.start();

      await transport1.connectTo(nodeId2);
      await transport1.connectTo(nodeId2); // Should return immediately

      expect(transport1.isConnectedTo(nodeId2)).toBe(true);
    });

    it('throws if transport is not running', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
      });

      await expect(transport1.connectTo(nodeId2)).rejects.toThrow(
        ClusterNotStartedError,
      );
    });
  });

  describe('disconnectFrom', () => {
    it('disconnects from a connected node', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });

      await transport1.start();
      await transport2.start();
      await transport1.connectTo(nodeId2);

      expect(transport1.isConnectedTo(nodeId2)).toBe(true);

      await transport1.disconnectFrom(nodeId2);

      expect(transport1.isConnectedTo(nodeId2)).toBe(false);
    });

    it('does nothing if not connected', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });

      await transport1.start();
      await transport1.disconnectFrom(nodeId2); // Should not throw

      expect(transport1.isConnectedTo(nodeId2)).toBe(false);
    });
  });

  describe('send', () => {
    it('sends message to connected node', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });

      await transport1.start();
      await transport2.start();
      await transport1.connectTo(nodeId2);

      // Give time for incoming connection to be established
      await new Promise((resolve) => setTimeout(resolve, 100));

      const messagePromise = new Promise<{
        envelope: MessageEnvelope;
        from: string;
      }>((resolve) => {
        transport2!.on('message', (envelope, from) => {
          resolve({ envelope, from });
        });
      });

      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: nodeId2 },
        msg: { data: 'hello' },
      };

      await transport1.send(nodeId2, message);

      const { envelope, from } = await messagePromise;

      expect(envelope.payload.type).toBe('cast');
      expect((envelope.payload as CastMessage).msg).toEqual({ data: 'hello' });
      expect(from).toBe(nodeId1);

      expect(transport1.getStats().totalMessagesSent).toBe(1);
    });

    it('throws when not connected to node', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });

      await transport1.start();

      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: nodeId2 },
        msg: { data: 'hello' },
      };

      await expect(transport1.send(nodeId2, message)).rejects.toThrow(
        'Not connected to node',
      );
    });

    it('throws when transport is not running', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
      });

      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: nodeId2 },
        msg: { data: 'hello' },
      };

      await expect(transport1.send(nodeId2, message)).rejects.toThrow(
        ClusterNotStartedError,
      );
    });
  });

  describe('broadcast', () => {
    it('sends message to all connected nodes', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });
      transport3 = new Transport({
        localNodeId: nodeId3,
        port: 4373,
      });

      await transport1.start();
      await transport2.start();
      await transport3.start();

      await transport1.connectTo(nodeId2);
      await transport1.connectTo(nodeId3);

      // Wait for connections to settle
      await new Promise((resolve) => setTimeout(resolve, 100));

      const receivedCount = { count: 0 };

      transport2.on('message', () => receivedCount.count++);
      transport3.on('message', () => receivedCount.count++);

      const message: HeartbeatMessage = {
        type: 'heartbeat',
        nodeInfo: {
          id: nodeId1,
          host: '127.0.0.1',
          port: 4371,
          status: 'connected',
          processCount: 0,
          lastHeartbeatAt: Date.now(),
          uptimeMs: 1000,
        },
        knownNodes: [],
      };

      const sentCount = await transport1.broadcast(message);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(sentCount).toBe(2);
      expect(receivedCount.count).toBe(2);
    });

    it('returns 0 when no nodes are connected', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });

      await transport1.start();

      const message: HeartbeatMessage = {
        type: 'heartbeat',
        nodeInfo: {
          id: nodeId1,
          host: '127.0.0.1',
          port: 4371,
          status: 'connected',
          processCount: 0,
          lastHeartbeatAt: Date.now(),
          uptimeMs: 1000,
        },
        knownNodes: [],
      };

      const sentCount = await transport1.broadcast(message);

      expect(sentCount).toBe(0);
    });
  });

  describe('incoming connections', () => {
    it('accepts incoming connections and emits events', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });

      await transport1.start();
      await transport2.start();

      const incomingPromise = new Promise<string>((resolve) => {
        transport1!.on('connectionEstablished', (nodeId) => {
          if (nodeId === nodeId2) resolve(nodeId);
        });
      });

      // transport2 connects to transport1
      await transport2.connectTo(nodeId1);

      // transport1 should receive incoming connection
      // First message from transport2 will identify it
      const message: HeartbeatMessage = {
        type: 'heartbeat',
        nodeInfo: {
          id: nodeId2,
          host: '127.0.0.1',
          port: 4372,
          status: 'connected',
          processCount: 0,
          lastHeartbeatAt: Date.now(),
          uptimeMs: 1000,
        },
        knownNodes: [],
      };

      await transport2.send(nodeId1, message);

      const incomingNodeId = await incomingPromise;
      expect(incomingNodeId).toBe(nodeId2);
    });
  });

  describe('connection events', () => {
    it('emits connectionLost when connection drops', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });

      await transport1.start();
      await transport2.start();
      await transport1.connectTo(nodeId2);

      // Ignore errors during disconnect test
      transport1.on('error', () => {});

      const lostPromise = new Promise<{ nodeId: string; reason: string }>(
        (resolve) => {
          transport1!.on('connectionLost', (nodeId, reason) => {
            resolve({ nodeId, reason });
          });
        },
      );

      // Stop transport2 to trigger connection loss
      await transport2.stop();

      const { nodeId, reason } = await lostPromise;
      expect(nodeId).toBe(nodeId2);
      expect(reason).toBeTruthy();
    });
  });

  describe('getConnectedNodes', () => {
    it('returns list of connected node IDs', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });
      transport3 = new Transport({
        localNodeId: nodeId3,
        port: 4373,
      });

      await transport1.start();
      await transport2.start();
      await transport3.start();

      await transport1.connectTo(nodeId2);
      await transport1.connectTo(nodeId3);

      const connectedNodes = transport1.getConnectedNodes();

      expect(connectedNodes).toContain(nodeId2);
      expect(connectedNodes).toContain(nodeId3);
      expect(connectedNodes.length).toBe(2);
    });

    it('returns empty array when no connections', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });

      await transport1.start();

      const connectedNodes = transport1.getConnectedNodes();
      expect(connectedNodes).toEqual([]);
    });
  });

  describe('isConnectedTo', () => {
    it('returns true when connected', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });

      await transport1.start();
      await transport2.start();
      await transport1.connectTo(nodeId2);

      expect(transport1.isConnectedTo(nodeId2)).toBe(true);
    });

    it('returns false when not connected', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });

      await transport1.start();

      expect(transport1.isConnectedTo(nodeId2)).toBe(false);
    });
  });

  describe('with cluster secret', () => {
    const clusterSecret = 'shared-cluster-secret';

    it('communicates securely with shared secret', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
        clusterSecret,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
        clusterSecret,
      });

      await transport1.start();
      await transport2.start();
      await transport1.connectTo(nodeId2);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const messagePromise = new Promise<MessageEnvelope>((resolve) => {
        transport2!.on('message', (envelope) => resolve(envelope));
      });

      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: nodeId2 },
        msg: { secret: 'data' },
      };

      await transport1.send(nodeId2, message);

      const envelope = await messagePromise;
      expect(envelope.signature).toBeDefined();
      expect((envelope.payload as CastMessage).msg).toEqual({ secret: 'data' });
    });
  });

  describe('concurrent operations', () => {
    it('handles multiple concurrent connectTo calls', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });
      transport3 = new Transport({
        localNodeId: nodeId3,
        port: 4373,
      });

      await transport1.start();
      await transport2.start();
      await transport3.start();

      // Connect to multiple nodes simultaneously
      await Promise.all([
        transport1.connectTo(nodeId2),
        transport1.connectTo(nodeId3),
      ]);

      expect(transport1.isConnectedTo(nodeId2)).toBe(true);
      expect(transport1.isConnectedTo(nodeId3)).toBe(true);
    });

    it('handles multiple concurrent send calls', async () => {
      transport1 = new Transport({
        localNodeId: nodeId1,
        port: 4371,
      });
      transport2 = new Transport({
        localNodeId: nodeId2,
        port: 4372,
      });

      await transport1.start();
      await transport2.start();
      await transport1.connectTo(nodeId2);

      await new Promise((resolve) => setTimeout(resolve, 100));

      let receivedCount = 0;
      transport2.on('message', () => receivedCount++);

      const messages = Array.from({ length: 10 }, (_, i): CastMessage => ({
        type: 'cast',
        ref: { id: `test-${i}`, nodeId: nodeId2 },
        msg: { index: i },
      }));

      await Promise.all(messages.map((msg) => transport1!.send(nodeId2, msg)));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedCount).toBe(10);
    });
  });
});
