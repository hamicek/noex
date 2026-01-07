import { describe, it, expect } from 'vitest';
import {
  NodeId,
  Serializer,
  generateCallId,
  isValidCallId,
  generateMonitorId,
  isValidMonitorId,
  MessageSerializationError,
  CLUSTER_DEFAULTS,
} from '../../src/index.js';
import type {
  ClusterMessage,
  HeartbeatMessage,
  CallMessage,
  CastMessage,
  MessageEnvelope,
  NodeIdType,
  CallId,
} from '../../src/index.js';

describe('Serializer', () => {
  const testNodeId = NodeId.parse('app1@localhost:4369');

  describe('serialize and deserialize', () => {
    it('serializes and deserializes heartbeat message', () => {
      const message: HeartbeatMessage = {
        type: 'heartbeat',
        nodeInfo: {
          id: testNodeId,
          host: 'localhost',
          port: 4369,
          status: 'connected',
          processCount: 5,
          lastHeartbeatAt: Date.now(),
          uptimeMs: 10000,
        },
        knownNodes: [testNodeId],
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const envelope = Serializer.deserialize(buffer);

      expect(envelope.version).toBe(CLUSTER_DEFAULTS.PROTOCOL_VERSION);
      expect(envelope.from).toBe(testNodeId);
      expect(envelope.payload.type).toBe('heartbeat');

      const payload = envelope.payload as HeartbeatMessage;
      expect(payload.nodeInfo.id).toBe(testNodeId);
      expect(payload.nodeInfo.status).toBe('connected');
      expect(payload.knownNodes).toContain(testNodeId);
    });

    it('serializes and deserializes call message', () => {
      const callId = generateCallId();
      const message: CallMessage = {
        type: 'call',
        callId,
        ref: { id: 'server-1', nodeId: testNodeId },
        msg: { type: 'get_count' },
        timeoutMs: 5000,
        sentAt: Date.now(),
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const envelope = Serializer.deserialize(buffer);

      const payload = envelope.payload as CallMessage;
      expect(payload.type).toBe('call');
      expect(payload.callId).toBe(callId);
      expect(payload.ref.id).toBe('server-1');
      expect(payload.ref.nodeId).toBe(testNodeId);
      expect(payload.msg).toEqual({ type: 'get_count' });
    });

    it('serializes and deserializes cast message', () => {
      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'worker-1', nodeId: testNodeId },
        msg: { type: 'process', data: [1, 2, 3] },
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const envelope = Serializer.deserialize(buffer);

      const payload = envelope.payload as CastMessage;
      expect(payload.type).toBe('cast');
      expect(payload.ref.id).toBe('worker-1');
      expect(payload.msg).toEqual({ type: 'process', data: [1, 2, 3] });
    });

    it('preserves timestamp in envelope', () => {
      const before = Date.now();
      const message: HeartbeatMessage = {
        type: 'heartbeat',
        nodeInfo: {
          id: testNodeId,
          host: 'localhost',
          port: 4369,
          status: 'connected',
          processCount: 0,
          lastHeartbeatAt: Date.now(),
          uptimeMs: 0,
        },
        knownNodes: [],
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const after = Date.now();
      const envelope = Serializer.deserialize(buffer);

      expect(envelope.timestamp).toBeGreaterThanOrEqual(before);
      expect(envelope.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('special type serialization', () => {
    it('serializes and deserializes Date objects', () => {
      const now = new Date();
      const message: ClusterMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { timestamp: now },
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const envelope = Serializer.deserialize(buffer);
      const payload = envelope.payload as CastMessage;
      const restoredDate = (payload.msg as { timestamp: Date }).timestamp;

      expect(restoredDate).toBeInstanceOf(Date);
      expect(restoredDate.getTime()).toBe(now.getTime());
    });

    it('serializes and deserializes Error objects', () => {
      const error = new Error('Test error');
      error.name = 'CustomError';

      const message: ClusterMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { error },
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const envelope = Serializer.deserialize(buffer);
      const payload = envelope.payload as CastMessage;
      const restoredError = (payload.msg as { error: Error }).error;

      expect(restoredError).toBeInstanceOf(Error);
      expect(restoredError.message).toBe('Test error');
      expect(restoredError.name).toBe('CustomError');
    });

    it('serializes and deserializes BigInt values', () => {
      const bigValue = BigInt('9007199254740993');
      const message: ClusterMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { value: bigValue },
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const envelope = Serializer.deserialize(buffer);
      const payload = envelope.payload as CastMessage;
      const restoredValue = (payload.msg as { value: bigint }).value;

      expect(restoredValue).toBe(bigValue);
    });

    it('serializes and deserializes Map objects', () => {
      const map = new Map([['key1', 'value1'], ['key2', 'value2']]);
      const message: ClusterMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { data: map },
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const envelope = Serializer.deserialize(buffer);
      const payload = envelope.payload as CastMessage;
      const restoredMap = (payload.msg as { data: Map<string, string> }).data;

      expect(restoredMap).toBeInstanceOf(Map);
      expect(restoredMap.get('key1')).toBe('value1');
      expect(restoredMap.get('key2')).toBe('value2');
    });

    it('serializes and deserializes Set objects', () => {
      const set = new Set([1, 2, 3]);
      const message: ClusterMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { data: set },
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const envelope = Serializer.deserialize(buffer);
      const payload = envelope.payload as CastMessage;
      const restoredSet = (payload.msg as { data: Set<number> }).data;

      expect(restoredSet).toBeInstanceOf(Set);
      expect(restoredSet.has(1)).toBe(true);
      expect(restoredSet.has(2)).toBe(true);
      expect(restoredSet.has(3)).toBe(true);
    });

    it('serializes and deserializes RegExp objects', () => {
      const regex = /test-\d+/gi;
      const message: ClusterMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { pattern: regex },
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const envelope = Serializer.deserialize(buffer);
      const payload = envelope.payload as CastMessage;
      const restoredRegex = (payload.msg as { pattern: RegExp }).pattern;

      expect(restoredRegex).toBeInstanceOf(RegExp);
      expect(restoredRegex.source).toBe('test-\\d+');
      expect(restoredRegex.flags).toBe('gi');
    });

    it('serializes and deserializes undefined values', () => {
      const message: ClusterMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { value: undefined, otherValue: 'exists' },
      };

      const buffer = Serializer.serialize(message, testNodeId);
      const envelope = Serializer.deserialize(buffer);
      const payload = envelope.payload as CastMessage;
      const msgObj = payload.msg as { value: undefined; otherValue: string };

      expect(msgObj.value).toBeUndefined();
      expect(msgObj.otherValue).toBe('exists');
    });
  });

  describe('HMAC signature', () => {
    const clusterSecret = 'super-secret-key';

    it('adds signature when cluster secret is provided', () => {
      const message: HeartbeatMessage = {
        type: 'heartbeat',
        nodeInfo: {
          id: testNodeId,
          host: 'localhost',
          port: 4369,
          status: 'connected',
          processCount: 0,
          lastHeartbeatAt: Date.now(),
          uptimeMs: 0,
        },
        knownNodes: [],
      };

      const buffer = Serializer.serialize(message, testNodeId, { clusterSecret });
      const envelope = Serializer.deserialize(buffer, { clusterSecret });

      expect(envelope.signature).toBeDefined();
      expect(envelope.signature).toHaveLength(64); // SHA-256 hex
    });

    it('verifies signature correctly', () => {
      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { data: 'sensitive' },
      };

      const buffer = Serializer.serialize(message, testNodeId, { clusterSecret });

      // Should not throw with correct secret
      expect(() => {
        Serializer.deserialize(buffer, { clusterSecret });
      }).not.toThrow();
    });

    it('rejects message with invalid signature', () => {
      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { data: 'sensitive' },
      };

      const buffer = Serializer.serialize(message, testNodeId, { clusterSecret });

      expect(() => {
        Serializer.deserialize(buffer, { clusterSecret: 'wrong-secret' });
      }).toThrow(MessageSerializationError);
    });

    it('rejects message without signature when required', () => {
      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { data: 'sensitive' },
      };

      // Serialize without secret
      const buffer = Serializer.serialize(message, testNodeId);

      // Should throw when verifying without signature
      expect(() => {
        Serializer.deserialize(buffer, { clusterSecret, requireSignature: true });
      }).toThrow(MessageSerializationError);
    });
  });

  describe('frame and unframe', () => {
    it('frames message with length prefix', () => {
      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { data: 'test' },
      };

      const payload = Serializer.serialize(message, testNodeId);
      const framed = Serializer.frame(payload);

      // Should have 4 bytes length prefix + payload
      expect(framed.length).toBe(4 + payload.length);

      // Length prefix should match payload length
      const length = framed.readUInt32BE(0);
      expect(length).toBe(payload.length);
    });

    it('unframes message correctly', () => {
      const message: CastMessage = {
        type: 'cast',
        ref: { id: 'test', nodeId: testNodeId },
        msg: { data: 'test' },
      };

      const payload = Serializer.serialize(message, testNodeId);
      const framed = Serializer.frame(payload);

      const result = Serializer.unframe(framed);

      expect(result.payload).not.toBeNull();
      expect(result.payload!.equals(payload)).toBe(true);
      expect(result.bytesConsumed).toBe(framed.length);
    });

    it('handles incomplete length prefix', () => {
      const buffer = Buffer.from([0x00, 0x00]); // Only 2 bytes
      const result = Serializer.unframe(buffer);

      expect(result.payload).toBeNull();
      expect(result.bytesConsumed).toBe(0);
    });

    it('handles incomplete message data', () => {
      const buffer = Buffer.allocUnsafe(8);
      buffer.writeUInt32BE(100, 0); // Says 100 bytes, but only 4 bytes of data
      buffer.write('test', 4);

      const result = Serializer.unframe(buffer);

      expect(result.payload).toBeNull();
      expect(result.bytesConsumed).toBe(0);
    });

    it('handles multiple messages in buffer', () => {
      const message1: CastMessage = {
        type: 'cast',
        ref: { id: 'test1', nodeId: testNodeId },
        msg: { data: '1' },
      };
      const message2: CastMessage = {
        type: 'cast',
        ref: { id: 'test2', nodeId: testNodeId },
        msg: { data: '2' },
      };

      const payload1 = Serializer.serialize(message1, testNodeId);
      const payload2 = Serializer.serialize(message2, testNodeId);
      const framed1 = Serializer.frame(payload1);
      const framed2 = Serializer.frame(payload2);

      const combined = Buffer.concat([framed1, framed2]);

      // Extract first message
      const result1 = Serializer.unframe(combined, 0);
      expect(result1.payload).not.toBeNull();

      const envelope1 = Serializer.deserialize(result1.payload!);
      expect((envelope1.payload as CastMessage).ref.id).toBe('test1');

      // Extract second message
      const result2 = Serializer.unframe(combined, result1.bytesConsumed);
      expect(result2.payload).not.toBeNull();

      const envelope2 = Serializer.deserialize(result2.payload!);
      expect((envelope2.payload as CastMessage).ref.id).toBe('test2');
    });

    it('throws for oversized messages', () => {
      const hugeBuffer = Buffer.allocUnsafe(4);
      hugeBuffer.writeUInt32BE(20 * 1024 * 1024, 0); // 20MB

      expect(() => Serializer.unframe(hugeBuffer)).toThrow(MessageSerializationError);
    });

    it('throws when framing oversized payload', () => {
      const hugePayload = Buffer.allocUnsafe(17 * 1024 * 1024); // 17MB

      expect(() => Serializer.frame(hugePayload)).toThrow(MessageSerializationError);
    });
  });

  describe('framedSize', () => {
    it('calculates correct framed size', () => {
      expect(Serializer.framedSize(100)).toBe(104);
      expect(Serializer.framedSize(0)).toBe(4);
      expect(Serializer.framedSize(1000)).toBe(1004);
    });
  });

  describe('constants', () => {
    it('exposes MAX_MESSAGE_SIZE', () => {
      expect(Serializer.MAX_MESSAGE_SIZE).toBe(16 * 1024 * 1024);
    });

    it('exposes LENGTH_PREFIX_SIZE', () => {
      expect(Serializer.LENGTH_PREFIX_SIZE).toBe(4);
    });
  });
});

describe('generateCallId', () => {
  it('generates unique CallIds', () => {
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      ids.add(generateCallId());
    }

    expect(ids.size).toBe(100);
  });

  it('generates valid CallId format', () => {
    const callId = generateCallId();
    expect(isValidCallId(callId)).toBe(true);
  });
});

describe('isValidCallId', () => {
  it('returns true for valid CallId', () => {
    const callId = generateCallId();
    expect(isValidCallId(callId)).toBe(true);
  });

  it('returns false for invalid formats', () => {
    expect(isValidCallId('')).toBe(false);
    expect(isValidCallId('invalid')).toBe(false);
    expect(isValidCallId('abc-123')).toBe(false);
    expect(isValidCallId('abc-' + 'x'.repeat(16))).toBe(false);
  });
});

describe('generateMonitorId', () => {
  it('generates unique MonitorIds', () => {
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      ids.add(generateMonitorId());
    }

    expect(ids.size).toBe(100);
  });

  it('generates valid MonitorId format', () => {
    const monitorId = generateMonitorId();
    expect(isValidMonitorId(monitorId)).toBe(true);
  });

  it('generates MonitorId with m prefix', () => {
    const monitorId = generateMonitorId();
    expect(monitorId.startsWith('m')).toBe(true);
  });
});

describe('isValidMonitorId', () => {
  it('returns true for valid MonitorId', () => {
    const monitorId = generateMonitorId();
    expect(isValidMonitorId(monitorId)).toBe(true);
  });

  it('returns false for invalid formats', () => {
    expect(isValidMonitorId('')).toBe(false);
    expect(isValidMonitorId('invalid')).toBe(false);
    expect(isValidMonitorId('abc-123')).toBe(false);
    // Missing 'm' prefix
    expect(isValidMonitorId('abc-' + 'a'.repeat(16))).toBe(false);
  });

  it('has m prefix for MonitorId', () => {
    // MonitorId always starts with 'm' prefix
    for (let i = 0; i < 10; i++) {
      const monitorId = generateMonitorId();
      expect(monitorId.startsWith('m')).toBe(true);
    }
  });

  it('validates format correctly', () => {
    // Valid MonitorId format: m[timestamp]-[16 hex chars]
    expect(isValidMonitorId('mabc123-0123456789abcdef')).toBe(true);
    expect(isValidMonitorId('m12345-fedcba9876543210')).toBe(true);

    // Invalid: missing m prefix
    expect(isValidMonitorId('abc123-0123456789abcdef')).toBe(false);
    // Invalid: s prefix (SpawnId)
    expect(isValidMonitorId('sabc123-0123456789abcdef')).toBe(false);
    // Invalid: wrong hex length
    expect(isValidMonitorId('mabc123-0123456789')).toBe(false);
  });
});

describe('MessageSerializationError', () => {
  it('creates error with serialize operation', () => {
    const cause = new Error('JSON cycle');
    const error = new MessageSerializationError('serialize', cause);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MessageSerializationError);
    expect(error.name).toBe('MessageSerializationError');
    expect(error.operation).toBe('serialize');
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('serialize');
    expect(error.message).toContain('JSON cycle');
  });

  it('creates error with deserialize operation', () => {
    const cause = new Error('Invalid JSON');
    const error = new MessageSerializationError('deserialize', cause);

    expect(error.operation).toBe('deserialize');
    expect(error.message).toContain('deserialize');
  });
});

describe('CLUSTER_DEFAULTS', () => {
  it('has correct default values', () => {
    expect(CLUSTER_DEFAULTS.HOST).toBe('0.0.0.0');
    expect(CLUSTER_DEFAULTS.PORT).toBe(4369);
    expect(CLUSTER_DEFAULTS.HEARTBEAT_INTERVAL_MS).toBe(5000);
    expect(CLUSTER_DEFAULTS.HEARTBEAT_MISS_THRESHOLD).toBe(3);
    expect(CLUSTER_DEFAULTS.RECONNECT_BASE_DELAY_MS).toBe(1000);
    expect(CLUSTER_DEFAULTS.RECONNECT_MAX_DELAY_MS).toBe(30000);
    expect(CLUSTER_DEFAULTS.PROTOCOL_VERSION).toBe(1);
  });

  it('is readonly (compile-time check)', () => {
    const port: 4369 = CLUSTER_DEFAULTS.PORT;
    expect(port).toBe(4369);
  });
});
