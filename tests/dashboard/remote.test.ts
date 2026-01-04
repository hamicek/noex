/**
 * Unit tests for Remote Dashboard (Server and Client).
 *
 * Tests the protocol, connection management, and server/client communication.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  serializeMessage,
  parseMessage,
  PROTOCOL_VERSION,
  LENGTH_PREFIX_SIZE,
  MAX_MESSAGE_SIZE,
  ProtocolError,
  type ServerMessage,
  type ClientMessage,
} from '../../src/dashboard/server/protocol.js';
import { DashboardConnection, DEFAULT_CONNECTION_CONFIG } from '../../src/dashboard/client/connection.js';
import { DashboardClient, DEFAULT_CLIENT_CONFIG } from '../../src/dashboard/client/dashboard-client.js';
import { DashboardServer, DEFAULT_SERVER_CONFIG } from '../../src/dashboard/server/dashboard-server.js';

describe('Protocol', () => {
  describe('constants', () => {
    it('has correct version', () => {
      expect(PROTOCOL_VERSION).toBe('1.0.0');
    });

    it('has correct length prefix size', () => {
      expect(LENGTH_PREFIX_SIZE).toBe(4);
    });

    it('has correct max message size', () => {
      expect(MAX_MESSAGE_SIZE).toBe(1024 * 1024); // 1MB
    });
  });

  describe('serializeMessage()', () => {
    it('serializes welcome message', () => {
      const message: ServerMessage = {
        type: 'welcome',
        payload: { version: '1.0.0', serverUptime: 1000 },
      };

      const buffer = serializeMessage(message);

      // Should have 4-byte length prefix + JSON payload
      expect(buffer.length).toBeGreaterThan(4);
      const payloadLength = buffer.readUInt32BE(0);
      expect(buffer.length).toBe(4 + payloadLength);
    });

    it('serializes client messages', () => {
      const messages: ClientMessage[] = [
        { type: 'get_snapshot' },
        { type: 'ping' },
        { type: 'stop_process', payload: { processId: 'test-123' } },
      ];

      for (const message of messages) {
        const buffer = serializeMessage(message);
        expect(buffer.length).toBeGreaterThan(4);
      }
    });

    it('produces valid length prefix', () => {
      const message: ClientMessage = { type: 'ping' };
      const buffer = serializeMessage(message);

      const payloadLength = buffer.readUInt32BE(0);
      const payload = buffer.subarray(4).toString('utf-8');

      expect(payload.length).toBe(payloadLength);
      expect(JSON.parse(payload)).toEqual(message);
    });
  });

  describe('parseMessage()', () => {
    it('parses complete message', () => {
      const original: ClientMessage = { type: 'get_snapshot' };
      const buffer = serializeMessage(original);

      const result = parseMessage<ClientMessage>(buffer);

      expect(result.message).toEqual(original);
      expect(result.bytesConsumed).toBe(buffer.length);
    });

    it('returns null for incomplete length prefix', () => {
      const buffer = Buffer.from([0, 0, 0]); // Only 3 bytes

      const result = parseMessage(buffer);

      expect(result.message).toBeNull();
      expect(result.bytesConsumed).toBe(0);
    });

    it('returns null for incomplete payload', () => {
      const buffer = Buffer.alloc(8);
      buffer.writeUInt32BE(100, 0); // Claims 100 bytes but only has 4

      const result = parseMessage(buffer);

      expect(result.message).toBeNull();
      expect(result.bytesConsumed).toBe(0);
    });

    it('throws for message exceeding max size', () => {
      const buffer = Buffer.alloc(8);
      buffer.writeUInt32BE(MAX_MESSAGE_SIZE + 1, 0);

      expect(() => parseMessage(buffer)).toThrow(ProtocolError);
      expect(() => parseMessage(buffer)).toThrow(/exceeds maximum/);
    });

    it('throws for invalid JSON', () => {
      const invalidJson = 'not valid json';
      const buffer = Buffer.alloc(4 + invalidJson.length);
      buffer.writeUInt32BE(invalidJson.length, 0);
      buffer.write(invalidJson, 4);

      expect(() => parseMessage(buffer)).toThrow(ProtocolError);
      expect(() => parseMessage(buffer)).toThrow(/Invalid JSON/);
    });

    it('handles multiple messages in buffer', () => {
      const msg1: ClientMessage = { type: 'ping' };
      const msg2: ClientMessage = { type: 'get_snapshot' };

      const buffer1 = serializeMessage(msg1);
      const buffer2 = serializeMessage(msg2);
      const combined = Buffer.concat([buffer1, buffer2]);

      // First parse
      const result1 = parseMessage<ClientMessage>(combined);
      expect(result1.message).toEqual(msg1);

      // Second parse from remaining buffer
      const remaining = combined.subarray(result1.bytesConsumed);
      const result2 = parseMessage<ClientMessage>(remaining);
      expect(result2.message).toEqual(msg2);
    });
  });

  describe('round-trip serialization', () => {
    it('preserves all server message types', () => {
      const messages: ServerMessage[] = [
        { type: 'welcome', payload: { version: '1.0.0', serverUptime: 5000 } },
        { type: 'error', payload: { code: 'TEST_ERROR', message: 'Test error message' } },
      ];

      for (const original of messages) {
        const buffer = serializeMessage(original);
        const result = parseMessage<ServerMessage>(buffer);
        expect(result.message).toEqual(original);
      }
    });

    it('preserves all client message types', () => {
      const messages: ClientMessage[] = [
        { type: 'get_snapshot' },
        { type: 'ping' },
        { type: 'stop_process', payload: { processId: 'test-id', reason: 'user request' } },
      ];

      for (const original of messages) {
        const buffer = serializeMessage(original);
        const result = parseMessage<ClientMessage>(buffer);
        expect(result.message).toEqual(original);
      }
    });
  });
});

describe('DashboardConnection', () => {
  describe('constructor', () => {
    it('creates with default config', () => {
      const connection = new DashboardConnection();
      expect(connection.getState()).toBe('disconnected');
      expect(connection.isConnected()).toBe(false);
    });

    it('accepts custom config', () => {
      const connection = new DashboardConnection({
        host: 'localhost',
        port: 8888,
        autoReconnect: false,
      });
      expect(connection.getState()).toBe('disconnected');
    });
  });

  describe('default configuration', () => {
    it('has correct defaults', () => {
      expect(DEFAULT_CONNECTION_CONFIG.host).toBe('127.0.0.1');
      expect(DEFAULT_CONNECTION_CONFIG.port).toBe(9876);
      expect(DEFAULT_CONNECTION_CONFIG.autoReconnect).toBe(true);
      expect(DEFAULT_CONNECTION_CONFIG.reconnectDelayMs).toBe(1000);
      expect(DEFAULT_CONNECTION_CONFIG.maxReconnectDelayMs).toBe(30000);
      expect(DEFAULT_CONNECTION_CONFIG.connectionTimeoutMs).toBe(5000);
    });
  });

  describe('event subscription', () => {
    it('allows subscribing and unsubscribing', () => {
      const connection = new DashboardConnection();
      const handler = () => {};

      const unsubscribe = connection.onEvent(handler);
      expect(typeof unsubscribe).toBe('function');

      // Should not throw
      expect(() => unsubscribe()).not.toThrow();
    });

    it('allows multiple handlers', () => {
      const connection = new DashboardConnection();
      const handler1 = () => {};
      const handler2 = () => {};

      const unsub1 = connection.onEvent(handler1);
      const unsub2 = connection.onEvent(handler2);

      expect(() => {
        unsub1();
        unsub2();
      }).not.toThrow();
    });
  });

  describe('send() without connection', () => {
    it('returns false when not connected', () => {
      const connection = new DashboardConnection();

      expect(connection.send({ type: 'ping' })).toBe(false);
      expect(connection.send({ type: 'get_snapshot' })).toBe(false);
    });

    it('ping() returns false when not connected', () => {
      const connection = new DashboardConnection();
      expect(connection.ping()).toBe(false);
    });

    it('requestSnapshot() returns false when not connected', () => {
      const connection = new DashboardConnection();
      expect(connection.requestSnapshot()).toBe(false);
    });
  });

  describe('disconnect()', () => {
    it('is safe to call when not connected', () => {
      const connection = new DashboardConnection();
      expect(() => connection.disconnect()).not.toThrow();
      expect(connection.getState()).toBe('disconnected');
    });
  });
});

describe('DashboardClient', () => {
  describe('constructor', () => {
    it('creates with default config', () => {
      const client = new DashboardClient();
      expect(client.isRunning()).toBe(false);
      expect(client.getLayout()).toBe('full');
    });

    it('accepts custom config', () => {
      const client = new DashboardClient({
        host: 'localhost',
        port: 8888,
        theme: 'light',
        layout: 'compact',
      });

      expect(client.isRunning()).toBe(false);
      expect(client.getLayout()).toBe('compact');
    });
  });

  describe('default configuration', () => {
    it('has correct defaults', () => {
      expect(DEFAULT_CLIENT_CONFIG.host).toBe('127.0.0.1');
      expect(DEFAULT_CLIENT_CONFIG.port).toBe(9876);
      expect(DEFAULT_CLIENT_CONFIG.theme).toBe('dark');
      expect(DEFAULT_CLIENT_CONFIG.layout).toBe('full');
      expect(DEFAULT_CLIENT_CONFIG.maxEventLogSize).toBe(100);
      expect(DEFAULT_CLIENT_CONFIG.autoReconnect).toBe(true);
    });
  });

  describe('isRunning()', () => {
    it('returns false before start', () => {
      const client = new DashboardClient();
      expect(client.isRunning()).toBe(false);
    });
  });

  describe('getLayout()', () => {
    it('returns configured layout', () => {
      expect(new DashboardClient().getLayout()).toBe('full');
      expect(new DashboardClient({ layout: 'compact' }).getLayout()).toBe('compact');
      expect(new DashboardClient({ layout: 'minimal' }).getLayout()).toBe('minimal');
    });
  });

  describe('switchLayout() when not running', () => {
    it('does not change layout when not running', () => {
      const client = new DashboardClient();
      expect(client.getLayout()).toBe('full');

      client.switchLayout('compact');
      expect(client.getLayout()).toBe('full'); // Should not change
    });
  });

  describe('stop() when not running', () => {
    it('is safe to call', () => {
      const client = new DashboardClient();
      expect(() => client.stop()).not.toThrow();
    });
  });
});

describe('DashboardServer', () => {
  describe('default configuration', () => {
    it('has correct defaults', () => {
      expect(DEFAULT_SERVER_CONFIG.port).toBe(9876);
      expect(DEFAULT_SERVER_CONFIG.host).toBe('127.0.0.1');
      expect(DEFAULT_SERVER_CONFIG.pollingIntervalMs).toBe(500);
    });
  });

  describe('start() and stop()', () => {
    it('can start and stop server', async () => {
      const ref = await DashboardServer.start({ port: 19876 }); // Use different port
      expect(ref).toBeDefined();

      const status = await DashboardServer.getStatus(ref);
      expect(status.status).toBe('running');
      expect(status.port).toBe(19876);
      expect(status.clientCount).toBe(0);

      await DashboardServer.stop(ref);
    });

    it('returns correct client count', async () => {
      const ref = await DashboardServer.start({ port: 19877 });

      const count = await DashboardServer.getClientCount(ref);
      expect(count).toBe(0);

      await DashboardServer.stop(ref);
    });

    it('reports uptime', async () => {
      const ref = await DashboardServer.start({ port: 19878 });

      // Wait a bit for uptime to accumulate
      await new Promise(resolve => setTimeout(resolve, 50));

      const status = await DashboardServer.getStatus(ref);
      expect(status.uptime).toBeGreaterThan(0);

      await DashboardServer.stop(ref);
    });
  });
});

describe('Server-Client Integration', () => {
  let serverRef: Awaited<ReturnType<typeof DashboardServer.start>> | null = null;
  let testPort = 19900; // Use unique ports per test

  afterEach(async () => {
    if (serverRef) {
      await DashboardServer.stop(serverRef);
      serverRef = null;
      // Wait for port to be released
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    testPort++; // Increment for next test
  });

  it('client can connect to server', async () => {
    serverRef = await DashboardServer.start({ port: testPort });

    const connection = new DashboardConnection({
      port: testPort,
      autoReconnect: false,
      connectionTimeoutMs: 2000,
    });

    const events: string[] = [];
    connection.onEvent((event) => {
      events.push(event.type);
    });

    await connection.connect();
    expect(connection.isConnected()).toBe(true);

    // Wait for welcome message
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(events).toContain('connected');
    expect(events).toContain('message'); // Welcome message

    connection.disconnect();
  });

  it('server tracks connected clients', async () => {
    serverRef = await DashboardServer.start({ port: testPort });

    const connection = new DashboardConnection({
      port: testPort,
      autoReconnect: false,
    });

    // Initially 0 clients
    let count = await DashboardServer.getClientCount(serverRef!);
    expect(count).toBe(0);

    // Connect
    await connection.connect();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Now 1 client
    count = await DashboardServer.getClientCount(serverRef!);
    expect(count).toBe(1);

    // Disconnect
    connection.disconnect();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Back to 0 clients
    count = await DashboardServer.getClientCount(serverRef!);
    expect(count).toBe(0);
  });

  it('client receives welcome message with version', async () => {
    serverRef = await DashboardServer.start({ port: testPort });

    const connection = new DashboardConnection({
      port: testPort,
      autoReconnect: false,
    });

    let welcomeReceived = false;
    let welcomePayload: { version: string; serverUptime: number } | null = null;

    connection.onEvent((event) => {
      if (event.type === 'message' && event.message.type === 'welcome') {
        welcomeReceived = true;
        welcomePayload = event.message.payload;
      }
    });

    await connection.connect();
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(welcomeReceived).toBe(true);
    expect(welcomePayload?.version).toBe(PROTOCOL_VERSION);
    expect(typeof welcomePayload?.serverUptime).toBe('number');

    connection.disconnect();
  });

  it('client receives snapshot after connecting', async () => {
    serverRef = await DashboardServer.start({ port: testPort });

    const connection = new DashboardConnection({
      port: testPort,
      autoReconnect: false,
    });

    let snapshotReceived = false;

    connection.onEvent((event) => {
      if (event.type === 'message' && event.message.type === 'snapshot') {
        snapshotReceived = true;
      }
    });

    await connection.connect();
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(snapshotReceived).toBe(true);

    connection.disconnect();
  });

  it('client can request snapshot', async () => {
    serverRef = await DashboardServer.start({ port: testPort });

    const connection = new DashboardConnection({
      port: testPort,
      autoReconnect: false,
    });

    let snapshotCount = 0;

    connection.onEvent((event) => {
      if (event.type === 'message' && event.message.type === 'snapshot') {
        snapshotCount++;
      }
    });

    await connection.connect();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Already received initial snapshot
    expect(snapshotCount).toBe(1);

    // Request another snapshot
    connection.requestSnapshot();
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(snapshotCount).toBe(2);

    connection.disconnect();
  });

  it('ping keeps connection alive', async () => {
    serverRef = await DashboardServer.start({ port: testPort });

    const connection = new DashboardConnection({
      port: testPort,
      autoReconnect: false,
    });

    await connection.connect();

    // Send multiple pings
    for (let i = 0; i < 3; i++) {
      const sent = connection.ping();
      expect(sent).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    expect(connection.isConnected()).toBe(true);

    connection.disconnect();
  });
});
