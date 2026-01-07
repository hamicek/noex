import { describe, it, expect } from 'vitest';
import {
  NodeId,
  isNodeId,
  InvalidNodeIdError,
} from '../../src/index.js';
import type { NodeIdType, NodeIdComponents } from '../../src/index.js';

describe('NodeId', () => {
  describe('parse', () => {
    it('parses valid NodeId with IPv4 address', () => {
      const nodeId = NodeId.parse('app1@192.168.1.1:4369');

      expect(nodeId).toBe('app1@192.168.1.1:4369');
      expect(NodeId.getName(nodeId)).toBe('app1');
      expect(NodeId.getHost(nodeId)).toBe('192.168.1.1');
      expect(NodeId.getPort(nodeId)).toBe(4369);
    });

    it('parses valid NodeId with hostname', () => {
      const nodeId = NodeId.parse('worker@node1.example.com:4369');

      expect(nodeId).toBe('worker@node1.example.com:4369');
      expect(NodeId.getName(nodeId)).toBe('worker');
      expect(NodeId.getHost(nodeId)).toBe('node1.example.com');
      expect(NodeId.getPort(nodeId)).toBe(4369);
    });

    it('parses valid NodeId with localhost', () => {
      const nodeId = NodeId.parse('dev@localhost:4369');

      expect(NodeId.getName(nodeId)).toBe('dev');
      expect(NodeId.getHost(nodeId)).toBe('localhost');
      expect(NodeId.getPort(nodeId)).toBe(4369);
    });

    it('parses valid NodeId with underscores and hyphens in name', () => {
      const nodeId1 = NodeId.parse('my_app@localhost:4369');
      const nodeId2 = NodeId.parse('my-app@localhost:4369');

      expect(NodeId.getName(nodeId1)).toBe('my_app');
      expect(NodeId.getName(nodeId2)).toBe('my-app');
    });

    it('parses valid NodeId with minimum port', () => {
      const nodeId = NodeId.parse('app@localhost:1');
      expect(NodeId.getPort(nodeId)).toBe(1);
    });

    it('parses valid NodeId with maximum port', () => {
      const nodeId = NodeId.parse('app@localhost:65535');
      expect(NodeId.getPort(nodeId)).toBe(65535);
    });

    it('throws InvalidNodeIdError for missing @ separator', () => {
      expect(() => NodeId.parse('applocalhost:4369')).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse('applocalhost:4369')).toThrow("missing '@' separator");
    });

    it('throws InvalidNodeIdError for missing : port separator', () => {
      expect(() => NodeId.parse('app@localhost')).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse('app@localhost')).toThrow("missing ':' port separator");
    });

    it('throws InvalidNodeIdError for empty name', () => {
      expect(() => NodeId.parse('@localhost:4369')).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse('@localhost:4369')).toThrow('name cannot be empty');
    });

    it('throws InvalidNodeIdError for name starting with number', () => {
      expect(() => NodeId.parse('1app@localhost:4369')).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse('1app@localhost:4369')).toThrow('name must start with a letter');
    });

    it('throws InvalidNodeIdError for name with invalid characters', () => {
      expect(() => NodeId.parse('app.name@localhost:4369')).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse('app name@localhost:4369')).toThrow(InvalidNodeIdError);
    });

    it('throws InvalidNodeIdError for name exceeding max length', () => {
      const longName = 'a'.repeat(65);
      expect(() => NodeId.parse(`${longName}@localhost:4369`)).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse(`${longName}@localhost:4369`)).toThrow('exceeds maximum length');
    });

    it('throws InvalidNodeIdError for empty host', () => {
      expect(() => NodeId.parse('app@:4369')).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse('app@:4369')).toThrow('host cannot be empty');
    });

    it('throws InvalidNodeIdError for invalid host', () => {
      expect(() => NodeId.parse('app@-invalid:4369')).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse('app@invalid-:4369')).toThrow(InvalidNodeIdError);
    });

    it('throws InvalidNodeIdError for invalid port', () => {
      expect(() => NodeId.parse('app@localhost:0')).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse('app@localhost:65536')).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse('app@localhost:abc')).toThrow(InvalidNodeIdError);
      expect(() => NodeId.parse('app@localhost:-1')).toThrow(InvalidNodeIdError);
    });

    it('throws InvalidNodeIdError for non-string input', () => {
      // @ts-expect-error Testing runtime behavior with invalid input
      expect(() => NodeId.parse(123)).toThrow(InvalidNodeIdError);
      // @ts-expect-error Testing runtime behavior with invalid input
      expect(() => NodeId.parse(null)).toThrow(InvalidNodeIdError);
    });
  });

  describe('tryParse', () => {
    it('returns NodeId for valid input', () => {
      const nodeId = NodeId.tryParse('app@localhost:4369');
      expect(nodeId).toBe('app@localhost:4369');
    });

    it('returns undefined for invalid input', () => {
      expect(NodeId.tryParse('invalid')).toBeUndefined();
      expect(NodeId.tryParse('app@localhost')).toBeUndefined();
      expect(NodeId.tryParse('@localhost:4369')).toBeUndefined();
    });
  });

  describe('create', () => {
    it('creates NodeId from components', () => {
      const nodeId = NodeId.create('app', '192.168.1.1', 4369);

      expect(nodeId).toBe('app@192.168.1.1:4369');
      expect(NodeId.getName(nodeId)).toBe('app');
      expect(NodeId.getHost(nodeId)).toBe('192.168.1.1');
      expect(NodeId.getPort(nodeId)).toBe(4369);
    });

    it('throws InvalidNodeIdError for invalid components', () => {
      expect(() => NodeId.create('', 'localhost', 4369)).toThrow(InvalidNodeIdError);
      expect(() => NodeId.create('app', '', 4369)).toThrow(InvalidNodeIdError);
      expect(() => NodeId.create('app', 'localhost', 0)).toThrow(InvalidNodeIdError);
    });
  });

  describe('components', () => {
    it('extracts all components at once', () => {
      const nodeId = NodeId.parse('worker@10.0.0.1:5000');
      const components: NodeIdComponents = NodeId.components(nodeId);

      expect(components.name).toBe('worker');
      expect(components.host).toBe('10.0.0.1');
      expect(components.port).toBe(5000);
    });
  });

  describe('isValid', () => {
    it('returns true for valid NodeId strings', () => {
      expect(NodeId.isValid('app@localhost:4369')).toBe(true);
      expect(NodeId.isValid('worker@192.168.1.1:5000')).toBe(true);
    });

    it('returns false for invalid strings', () => {
      expect(NodeId.isValid('invalid')).toBe(false);
      expect(NodeId.isValid('app@localhost')).toBe(false);
      expect(NodeId.isValid('')).toBe(false);
    });

    it('acts as type guard', () => {
      const value: string = 'app@localhost:4369';

      if (NodeId.isValid(value)) {
        // TypeScript now knows value is NodeId
        const name: string = NodeId.getName(value);
        expect(name).toBe('app');
      }
    });
  });

  describe('equals', () => {
    it('returns true for equal NodeIds', () => {
      const a = NodeId.parse('app@localhost:4369');
      const b = NodeId.parse('app@localhost:4369');

      expect(NodeId.equals(a, b)).toBe(true);
    });

    it('returns false for different NodeIds', () => {
      const a = NodeId.parse('app1@localhost:4369');
      const b = NodeId.parse('app2@localhost:4369');

      expect(NodeId.equals(a, b)).toBe(false);
    });
  });

  describe('toString', () => {
    it('returns the NodeId string', () => {
      const nodeId = NodeId.parse('app@localhost:4369');
      expect(NodeId.toString(nodeId)).toBe('app@localhost:4369');
    });
  });

  describe('IPv4 validation', () => {
    it('accepts valid IPv4 addresses', () => {
      expect(NodeId.isValid('app@0.0.0.0:4369')).toBe(true);
      expect(NodeId.isValid('app@127.0.0.1:4369')).toBe(true);
      expect(NodeId.isValid('app@255.255.255.255:4369')).toBe(true);
      expect(NodeId.isValid('app@10.0.0.1:4369')).toBe(true);
    });

    it('rejects invalid IPv4 addresses', () => {
      expect(NodeId.isValid('app@256.0.0.1:4369')).toBe(false);
      expect(NodeId.isValid('app@1.2.3.4.5:4369')).toBe(false);
      expect(NodeId.isValid('app@1.2.3:4369')).toBe(false);
    });
  });

  describe('hostname validation', () => {
    it('accepts valid hostnames', () => {
      expect(NodeId.isValid('app@localhost:4369')).toBe(true);
      expect(NodeId.isValid('app@node1:4369')).toBe(true);
      expect(NodeId.isValid('app@node-1:4369')).toBe(true);
      expect(NodeId.isValid('app@a.b.c:4369')).toBe(true);
      expect(NodeId.isValid('app@example.com:4369')).toBe(true);
      expect(NodeId.isValid('app@sub.domain.example.com:4369')).toBe(true);
    });

    it('rejects hostnames starting or ending with hyphen', () => {
      expect(NodeId.isValid('app@-node:4369')).toBe(false);
      expect(NodeId.isValid('app@node-:4369')).toBe(false);
    });
  });
});

describe('isNodeId type guard', () => {
  it('returns true for valid NodeId strings', () => {
    expect(isNodeId('app@localhost:4369')).toBe(true);
  });

  it('returns false for invalid values', () => {
    expect(isNodeId('invalid')).toBe(false);
    expect(isNodeId(123)).toBe(false);
    expect(isNodeId(null)).toBe(false);
    expect(isNodeId(undefined)).toBe(false);
    expect(isNodeId({})).toBe(false);
  });

  it('narrows type correctly', () => {
    const maybeNodeId: unknown = 'app@localhost:4369';

    if (isNodeId(maybeNodeId)) {
      // TypeScript now knows maybeNodeId is NodeId
      const name = NodeId.getName(maybeNodeId);
      expect(name).toBe('app');
    }
  });
});

describe('InvalidNodeIdError', () => {
  it('creates error with correct properties', () => {
    const error = new InvalidNodeIdError('bad-value', 'missing port');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(InvalidNodeIdError);
    expect(error.name).toBe('InvalidNodeIdError');
    expect(error.value).toBe('bad-value');
    expect(error.reason).toBe('missing port');
    expect(error.message).toBe("Invalid NodeId 'bad-value': missing port");
  });

  it('can be caught as Error', () => {
    try {
      throw new InvalidNodeIdError('test', 'reason');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});

describe('NodeIdType (compile-time type checks)', () => {
  it('NodeIdType is assignable from NodeId.parse result', () => {
    const nodeId: NodeIdType = NodeId.parse('app@localhost:4369');
    expect(nodeId).toBe('app@localhost:4369');
  });

  it('plain string is not assignable to NodeIdType', () => {
    // This is a compile-time check - the type system prevents:
    // const nodeId: NodeIdType = 'app@localhost:4369'; // Error!
    // We can only verify this works at runtime through parsing
    const validated: NodeIdType = NodeId.parse('app@localhost:4369');
    expect(typeof validated).toBe('string');
  });
});
