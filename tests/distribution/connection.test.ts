import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import {
  Connection,
  NodeId,
  Serializer,
  NodeNotReachableError,
} from '../../src/index.js';
import type {
  HeartbeatMessage,
  CastMessage,
} from '../../src/index.js';

describe('Connection', () => {
  const localNodeId = NodeId.parse('local@127.0.0.1:4369');
  const remoteNodeId = NodeId.parse('remote@127.0.0.1:4370');

  let server: net.Server | null = null;
  let serverSocket: net.Socket | null = null;
  let connection: Connection | null = null;

  beforeEach(() => {
    server = null;
    serverSocket = null;
    connection = null;
  });

  afterEach(async () => {
    if (connection) {
      connection.destroy();
      connection = null;
    }
    if (serverSocket) {
      serverSocket.destroy();
      serverSocket = null;
    }
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }
  });

  function createTestServer(port: number): Promise<void> {
    return new Promise((resolve) => {
      server = net.createServer((socket) => {
        serverSocket = socket;
      });
      server.listen(port, '127.0.0.1', () => resolve());
    });
  }

  function waitForServerSocket(timeoutMs = 1000): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (serverSocket) {
          resolve(serverSocket);
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error('Timeout waiting for server socket'));
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  describe('constructor', () => {
    it('creates connection with default configuration', () => {
      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      expect(connection.getState()).toBe('disconnected');
      expect(connection.getRemoteNodeId()).toBe(remoteNodeId);
    });

    it('creates connection with custom configuration', () => {
      connection = new Connection({
        remoteNodeId,
        localNodeId,
        reconnectBaseDelayMs: 500,
        reconnectMaxDelayMs: 5000,
        maxReconnectAttempts: 5,
        connectTimeoutMs: 3000,
        clusterSecret: 'test-secret',
      });

      expect(connection.getState()).toBe('disconnected');
    });
  });

  describe('getStats', () => {
    it('returns initial statistics', () => {
      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      const stats = connection.getStats();

      expect(stats.state).toBe('disconnected');
      expect(stats.remoteNodeId).toBe(remoteNodeId);
      expect(stats.messagesSent).toBe(0);
      expect(stats.messagesReceived).toBe(0);
      expect(stats.bytesSent).toBe(0);
      expect(stats.bytesReceived).toBe(0);
      expect(stats.lastSentAt).toBeNull();
      expect(stats.lastReceivedAt).toBeNull();
      expect(stats.reconnectAttempts).toBe(0);
      expect(stats.connectedAt).toBeNull();
    });
  });

  describe('connect', () => {
    it('connects to a listening server', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      const connectedPromise = new Promise<void>((resolve) => {
        connection!.on('connected', () => resolve());
      });

      await connection.connect();
      await connectedPromise;

      expect(connection.getState()).toBe('connected');
      expect(connection.getStats().connectedAt).not.toBeNull();
    });

    it('returns immediately if already connected', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      await connection.connect();
      await connection.connect(); // Should return immediately

      expect(connection.getState()).toBe('connected');
    });

    it('waits if connection is in progress', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      // Start two connects simultaneously
      await Promise.all([
        connection.connect(),
        connection.connect(),
      ]);

      expect(connection.getState()).toBe('connected');
    });

    it('fails with timeout if server is not reachable', async () => {
      connection = new Connection({
        remoteNodeId,
        localNodeId,
        connectTimeoutMs: 100,
        maxReconnectAttempts: 0, // Disable reconnection
      });

      await expect(connection.connect()).rejects.toThrow(NodeNotReachableError);
    }, 10000);
  });

  describe('send', () => {
    it('sends message to connected server', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      await connection.connect();
      const socket = await waitForServerSocket();

      const receivedData: Buffer[] = [];
      socket.on('data', (data) => receivedData.push(data));

      const message: HeartbeatMessage = {
        type: 'heartbeat',
        nodeInfo: {
          id: localNodeId,
          host: '127.0.0.1',
          port: 4369,
          status: 'connected',
          processCount: 0,
          lastHeartbeatAt: Date.now(),
          uptimeMs: 1000,
        },
        knownNodes: [],
      };

      await connection.send(message);

      // Wait for data to arrive
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedData.length).toBeGreaterThan(0);

      const stats = connection.getStats();
      expect(stats.messagesSent).toBe(1);
      expect(stats.bytesSent).toBeGreaterThan(0);
      expect(stats.lastSentAt).not.toBeNull();
    });

    it('throws when not connected', async () => {
      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: remoteNodeId },
        msg: { data: 'test' },
      };

      await expect(connection.send(message)).rejects.toThrow(NodeNotReachableError);
    });
  });

  describe('message reception', () => {
    it('receives and parses messages from server', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      const messagePromise = new Promise<unknown>((resolve) => {
        connection!.on('message', (envelope) => resolve(envelope));
      });

      await connection.connect();
      const socket = await waitForServerSocket();

      // Server sends a message
      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: remoteNodeId },
        msg: { data: 'hello' },
      };

      const payload = Serializer.serialize(message, remoteNodeId);
      const framed = Serializer.frame(payload);
      socket.write(framed);

      const envelope = await messagePromise;

      expect(envelope).toBeDefined();
      expect((envelope as any).payload.type).toBe('cast');
      expect((envelope as any).from).toBe(remoteNodeId);

      const stats = connection.getStats();
      expect(stats.messagesReceived).toBe(1);
      expect(stats.bytesReceived).toBeGreaterThan(0);
    });

    it('handles multiple messages in single data chunk', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      const messages: unknown[] = [];
      connection.on('message', (envelope) => messages.push(envelope));

      await connection.connect();
      const socket = await waitForServerSocket();

      // Server sends two messages in one chunk
      const message1: CastMessage = {
        type: 'cast',
        ref: { id: 'test1', nodeId: remoteNodeId },
        msg: { data: '1' },
      };
      const message2: CastMessage = {
        type: 'cast',
        ref: { id: 'test2', nodeId: remoteNodeId },
        msg: { data: '2' },
      };

      const payload1 = Serializer.serialize(message1, remoteNodeId);
      const payload2 = Serializer.serialize(message2, remoteNodeId);
      const framed1 = Serializer.frame(payload1);
      const framed2 = Serializer.frame(payload2);

      socket.write(Buffer.concat([framed1, framed2]));

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages.length).toBe(2);
    });

    it('handles fragmented messages across data chunks', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      const messagePromise = new Promise<unknown>((resolve) => {
        connection!.on('message', (envelope) => resolve(envelope));
      });

      await connection.connect();
      const socket = await waitForServerSocket();

      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: remoteNodeId },
        msg: { data: 'hello' },
      };

      const payload = Serializer.serialize(message, remoteNodeId);
      const framed = Serializer.frame(payload);

      // Split the frame into chunks
      const mid = Math.floor(framed.length / 2);
      socket.write(framed.subarray(0, mid));

      await new Promise((resolve) => setTimeout(resolve, 10));

      socket.write(framed.subarray(mid));

      const envelope = await messagePromise;
      expect(envelope).toBeDefined();
    });
  });

  describe('close', () => {
    it('gracefully closes the connection', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      await connection.connect();
      expect(connection.getState()).toBe('connected');

      await connection.close();
      expect(connection.getState()).toBe('disconnected');
    });

    it('resolves immediately if already disconnected', async () => {
      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      await connection.close();
      expect(connection.getState()).toBe('disconnected');
    });
  });

  describe('destroy', () => {
    it('immediately destroys the connection', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      await connection.connect();
      connection.destroy();

      expect(connection.getState()).toBe('disconnected');
    });
  });

  describe('adopt', () => {
    it('adopts an existing socket', async () => {
      await createTestServer(4370);

      // Create a client socket
      const clientSocket = await new Promise<net.Socket>((resolve) => {
        const socket = new net.Socket();
        socket.connect(4370, '127.0.0.1', () => resolve(socket));
      });

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      const connectedPromise = new Promise<void>((resolve) => {
        connection!.on('connected', () => resolve());
      });

      connection.adopt(clientSocket);

      await connectedPromise;
      expect(connection.getState()).toBe('connected');

      clientSocket.destroy();
    });
  });

  describe('reconnection', () => {
    it('emits reconnecting event on disconnect', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
        reconnectBaseDelayMs: 50,
        maxReconnectAttempts: 1,
      });

      await connection.connect();
      const socket = await waitForServerSocket();

      const reconnectingPromise = new Promise<{ attempt: number; delayMs: number }>(
        (resolve) => {
          connection!.on('reconnecting', (attempt, delayMs) =>
            resolve({ attempt, delayMs }),
          );
        },
      );

      // Close server to trigger disconnect
      socket.destroy();

      const { attempt, delayMs } = await reconnectingPromise;
      expect(attempt).toBe(1);
      expect(delayMs).toBeGreaterThan(0);
    }, 10000);

    it('emits reconnectFailed after max attempts', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
        reconnectBaseDelayMs: 10,
        maxReconnectAttempts: 2,
        connectTimeoutMs: 50,
      });

      await connection.connect();
      const socket = await waitForServerSocket();

      const failedPromise = new Promise<void>((resolve) => {
        connection!.on('reconnectFailed', () => resolve());
      });

      // Close server and stop listening
      socket.destroy();
      serverSocket = null;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;

      await failedPromise;
    }, 15000);

    it('uses exponential backoff with jitter', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
        reconnectBaseDelayMs: 100,
        maxReconnectAttempts: 3,
        connectTimeoutMs: 50,
      });

      await connection.connect();
      const socket = await waitForServerSocket();

      const delays: number[] = [];
      connection.on('reconnecting', (_, delayMs) => delays.push(delayMs));

      // Close server and stop listening
      socket.destroy();
      serverSocket = null;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;

      await new Promise<void>((resolve) => {
        connection!.on('reconnectFailed', () => resolve());
      });

      // Verify exponential backoff (with jitter, delays should generally increase)
      expect(delays.length).toBe(3);
      // Due to jitter, we can't make exact assertions, but delays should be in reasonable ranges
      expect(delays[0]).toBeGreaterThanOrEqual(50); // 100 * 0.5
      expect(delays[0]).toBeLessThanOrEqual(150); // 100 * 1.5
    }, 15000);
  });

  describe('events', () => {
    it('emits connected event', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      const connectedPromise = new Promise<void>((resolve) => {
        connection!.on('connected', () => resolve());
      });

      await connection.connect();
      await connectedPromise;
    });

    it('emits disconnected event with reason', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
        maxReconnectAttempts: 0, // Disable reconnection
      });

      await connection.connect();
      const socket = await waitForServerSocket();

      const disconnectedPromise = new Promise<string>((resolve) => {
        connection!.on('disconnected', (reason) => resolve(reason));
      });

      socket.destroy();

      const reason = await disconnectedPromise;
      expect(reason).toBe('socket closed');
    });

    it('emits error event on deserialization error', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
      });

      const errorPromise = new Promise<Error>((resolve) => {
        connection!.on('error', (err) => resolve(err));
      });

      await connection.connect();
      const socket = await waitForServerSocket();

      // Send invalid framed data
      const invalidData = Buffer.allocUnsafe(8);
      invalidData.writeUInt32BE(4, 0); // Length = 4
      invalidData.write('bad!', 4); // Invalid JSON
      socket.write(invalidData);

      const error = await errorPromise;
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('with cluster secret', () => {
    const clusterSecret = 'test-secret-key';

    it('sends signed messages', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
        clusterSecret,
      });

      await connection.connect();
      const socket = await waitForServerSocket();

      const receivedData: Buffer[] = [];
      socket.on('data', (data) => receivedData.push(data));

      const message: HeartbeatMessage = {
        type: 'heartbeat',
        nodeInfo: {
          id: localNodeId,
          host: '127.0.0.1',
          port: 4369,
          status: 'connected',
          processCount: 0,
          lastHeartbeatAt: Date.now(),
          uptimeMs: 1000,
        },
        knownNodes: [],
      };

      await connection.send(message);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const combined = Buffer.concat(receivedData);
      const result = Serializer.unframe(combined, 0);
      expect(result.payload).not.toBeNull();

      const envelope = Serializer.deserialize(result.payload!, { clusterSecret });
      expect(envelope.signature).toBeDefined();
    });

    it('verifies incoming message signatures', async () => {
      await createTestServer(4370);

      connection = new Connection({
        remoteNodeId,
        localNodeId,
        clusterSecret,
      });

      const messagePromise = new Promise<unknown>((resolve) => {
        connection!.on('message', (envelope) => resolve(envelope));
      });

      await connection.connect();
      const socket = await waitForServerSocket();

      // Server sends a signed message
      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: remoteNodeId },
        msg: { data: 'hello' },
      };

      const payload = Serializer.serialize(message, remoteNodeId, { clusterSecret });
      const framed = Serializer.frame(payload);
      socket.write(framed);

      const envelope = await messagePromise;
      expect(envelope).toBeDefined();
    });
  });
});
