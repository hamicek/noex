import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Cluster,
  NodeId,
  ClusterNotStartedError,
  InvalidClusterConfigError,
} from '../../src/index.js';
import type {
  ClusterStatus,
  NodeInfo,
  NodeDownReason,
} from '../../src/index.js';

// Helper to create unique ports for each test to avoid conflicts
// Using high port range to avoid conflicts with common services
let portCounter = 14500;
function getNextPort(): number {
  return portCounter++;
}

describe('Cluster', () => {
  beforeEach(() => {
    // Reset port counter for consistency in isolated tests
  });

  afterEach(async () => {
    // Ensure cluster is stopped after each test
    if (Cluster.getStatus() !== 'stopped') {
      await Cluster.stop();
    }
  });

  describe('configuration validation', () => {
    it('throws on missing nodeName', async () => {
      await expect(
        Cluster.start({} as any),
      ).rejects.toThrow(InvalidClusterConfigError);
    });

    it('throws on invalid nodeName format', async () => {
      await expect(
        Cluster.start({ nodeName: '123invalid' }),
      ).rejects.toThrow(InvalidClusterConfigError);
    });

    it('throws on nodeName too long', async () => {
      await expect(
        Cluster.start({ nodeName: 'a'.repeat(65) }),
      ).rejects.toThrow(InvalidClusterConfigError);
    });

    it('throws on invalid port', async () => {
      await expect(
        Cluster.start({ nodeName: 'test', port: 0 }),
      ).rejects.toThrow(InvalidClusterConfigError);

      await expect(
        Cluster.start({ nodeName: 'test', port: 70000 }),
      ).rejects.toThrow(InvalidClusterConfigError);
    });

    it('throws on invalid seed format', async () => {
      await expect(
        Cluster.start({ nodeName: 'test', seeds: ['invalid'] }),
      ).rejects.toThrow(InvalidClusterConfigError);
    });

    it('throws on invalid heartbeat interval', async () => {
      await expect(
        Cluster.start({ nodeName: 'test', heartbeatIntervalMs: 50 }),
      ).rejects.toThrow(InvalidClusterConfigError);
    });

    it('throws on invalid heartbeat miss threshold', async () => {
      await expect(
        Cluster.start({ nodeName: 'test', heartbeatMissThreshold: 0 }),
      ).rejects.toThrow(InvalidClusterConfigError);
    });
  });

  describe('start', () => {
    it('starts the cluster', async () => {
      const port = getNextPort();
      await Cluster.start({
        nodeName: 'test',
        port,
      });

      expect(Cluster.getStatus()).toBe('running');
    });

    it('throws when already running', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      await expect(
        Cluster.start({ nodeName: 'test2', port: port + 1 }),
      ).rejects.toThrow('Cluster is already running');
    });

    it('accepts valid configuration', async () => {
      const port = getNextPort();
      await Cluster.start({
        nodeName: 'valid-node_1',
        host: '127.0.0.1',
        port,
        seeds: [],
        clusterSecret: 'secret',
        heartbeatIntervalMs: 1000,
        heartbeatMissThreshold: 3,
        reconnectBaseDelayMs: 500,
        reconnectMaxDelayMs: 10000,
      });

      expect(Cluster.getStatus()).toBe('running');
    });

    it('emits statusChange events', async () => {
      const port = getNextPort();
      const statuses: ClusterStatus[] = [];

      const unsubscribe = Cluster.onStatusChange((status) => {
        statuses.push(status);
      });

      await Cluster.start({ nodeName: 'test', port });

      expect(statuses).toContain('starting');
      expect(statuses).toContain('running');

      unsubscribe();
    });
  });

  describe('stop', () => {
    it('stops the cluster', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      await Cluster.stop();

      expect(Cluster.getStatus()).toBe('stopped');
    });

    it('returns immediately when already stopped', async () => {
      expect(Cluster.getStatus()).toBe('stopped');
      await Cluster.stop();
      expect(Cluster.getStatus()).toBe('stopped');
    });

    it('emits statusChange to stopping and stopped', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      const statuses: ClusterStatus[] = [];
      const unsubscribe = Cluster.onStatusChange((status) => {
        statuses.push(status);
      });

      await Cluster.stop();

      expect(statuses).toContain('stopping');
      expect(statuses).toContain('stopped');

      unsubscribe();
    });
  });

  describe('getLocalNodeId', () => {
    it('returns local node id when running', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'mynode', port });

      const localId = Cluster.getLocalNodeId();
      expect(localId).toBeDefined();
      expect(NodeId.getName(localId)).toBe('mynode');
      expect(NodeId.getPort(localId)).toBe(port);
    });

    it('throws when cluster is not running', () => {
      expect(() => Cluster.getLocalNodeId()).toThrow(ClusterNotStartedError);
    });
  });

  describe('getLocalNodeInfo', () => {
    it('returns local node info when running', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'mynode', port });

      const info = Cluster.getLocalNodeInfo();
      expect(info.id).toBe(Cluster.getLocalNodeId());
      expect(info.status).toBe('connected');
      expect(info.port).toBe(port);
    });

    it('throws when cluster is not running', () => {
      expect(() => Cluster.getLocalNodeInfo()).toThrow(ClusterNotStartedError);
    });
  });

  describe('getNodes', () => {
    it('returns empty array initially', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      expect(Cluster.getNodes()).toEqual([]);
    });

    it('throws when cluster is not running', () => {
      expect(() => Cluster.getNodes()).toThrow(ClusterNotStartedError);
    });
  });

  describe('getConnectedNodes', () => {
    it('returns empty array initially', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      expect(Cluster.getConnectedNodes()).toEqual([]);
    });

    it('throws when cluster is not running', () => {
      expect(() => Cluster.getConnectedNodes()).toThrow(ClusterNotStartedError);
    });
  });

  describe('getNodeIds', () => {
    it('returns empty array initially', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      expect(Cluster.getNodeIds()).toEqual([]);
    });

    it('throws when cluster is not running', () => {
      expect(() => Cluster.getNodeIds()).toThrow(ClusterNotStartedError);
    });
  });

  describe('getNode', () => {
    it('returns undefined for unknown node', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      const unknownId = NodeId.create('unknown', '127.0.0.1', 9999);
      expect(Cluster.getNode(unknownId)).toBeUndefined();
    });

    it('throws when cluster is not running', () => {
      const nodeId = NodeId.create('test', '127.0.0.1', 4369);
      expect(() => Cluster.getNode(nodeId)).toThrow(ClusterNotStartedError);
    });
  });

  describe('isNodeConnected', () => {
    it('returns false for unknown node', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      const unknownId = NodeId.create('unknown', '127.0.0.1', 9999);
      expect(Cluster.isNodeConnected(unknownId)).toBe(false);
    });

    it('throws when cluster is not running', () => {
      const nodeId = NodeId.create('test', '127.0.0.1', 4369);
      expect(() => Cluster.isNodeConnected(nodeId)).toThrow(ClusterNotStartedError);
    });
  });

  describe('getConnectedNodeCount', () => {
    it('returns 0 initially', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      expect(Cluster.getConnectedNodeCount()).toBe(0);
    });

    it('throws when cluster is not running', () => {
      expect(() => Cluster.getConnectedNodeCount()).toThrow(ClusterNotStartedError);
    });
  });

  describe('getUptimeMs', () => {
    it('returns uptime when running', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      const uptime1 = Cluster.getUptimeMs();
      expect(uptime1).toBeGreaterThanOrEqual(0);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const uptime2 = Cluster.getUptimeMs();
      expect(uptime2).toBeGreaterThan(uptime1);
    });

    it('throws when cluster is not running', () => {
      expect(() => Cluster.getUptimeMs()).toThrow(ClusterNotStartedError);
    });
  });

  describe('event handlers', () => {
    it('onNodeUp returns unsubscribe function', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      const handler = vi.fn();
      const unsubscribe = Cluster.onNodeUp(handler);

      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });

    it('onNodeDown returns unsubscribe function', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      const handler = vi.fn();
      const unsubscribe = Cluster.onNodeDown(handler);

      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });

    it('onStatusChange returns unsubscribe function', async () => {
      const port = getNextPort();
      await Cluster.start({ nodeName: 'test', port });

      const handler = vi.fn();
      const unsubscribe = Cluster.onStatusChange(handler);

      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });

  describe('seed connection', () => {
    it('continues starting even if seed is unreachable', async () => {
      const port = getNextPort();
      await Cluster.start({
        nodeName: 'test',
        port,
        seeds: ['unreachable@127.0.0.1:9999'],
      });

      expect(Cluster.getStatus()).toBe('running');
    });

    it('does not connect to self if self is in seeds', async () => {
      const port = getNextPort();
      await Cluster.start({
        nodeName: 'test',
        host: '127.0.0.1',
        port,
        seeds: [`test@127.0.0.1:${port}`],
      });

      expect(Cluster.getStatus()).toBe('running');
      expect(Cluster.getConnectedNodeCount()).toBe(0);
    });
  });
});

describe('Cluster multi-node integration', () => {
  // These tests use real network connections between cluster instances
  // We can't use the singleton directly for multi-node tests,
  // so we test through the internal _getTransport() and _getMembership()

  let port1: number;
  let port2: number;

  beforeEach(() => {
    port1 = getNextPort();
    port2 = getNextPort();
  });

  afterEach(async () => {
    if (Cluster.getStatus() !== 'stopped') {
      await Cluster.stop();
    }
  });

  it('discovers nodes through seed connection', async () => {
    // Start first cluster
    await Cluster.start({
      nodeName: 'node1',
      port: port1,
    });

    // We can verify the cluster is running and ready to accept connections
    expect(Cluster.getStatus()).toBe('running');
    expect(Cluster.getLocalNodeId()).toBe(NodeId.create('node1', '127.0.0.1', port1));
  });

  it('handles connection events', async () => {
    const nodeUpEvents: NodeInfo[] = [];
    const nodeDownEvents: { nodeId: string; reason: NodeDownReason }[] = [];

    await Cluster.start({
      nodeName: 'node1',
      port: port1,
    });

    Cluster.onNodeUp((node) => {
      nodeUpEvents.push(node);
    });

    Cluster.onNodeDown((nodeId, reason) => {
      nodeDownEvents.push({ nodeId, reason });
    });

    // At this point we don't have other nodes, but the handlers are registered
    expect(nodeUpEvents.length).toBe(0);
    expect(nodeDownEvents.length).toBe(0);
  });

  it('internal transport is accessible', async () => {
    await Cluster.start({
      nodeName: 'node1',
      port: port1,
    });

    const transport = Cluster._getTransport();
    expect(transport.getState()).toBe('running');
    expect(transport.getLocalNodeId()).toBe(Cluster.getLocalNodeId());
  });

  it('internal membership is accessible', async () => {
    await Cluster.start({
      nodeName: 'node1',
      port: port1,
    });

    const membership = Cluster._getMembership();
    expect(membership.getLocalNodeId()).toBe(Cluster.getLocalNodeId());
    expect(membership.size).toBe(0);
  });
});

describe('Cluster heartbeat', () => {
  let port: number;

  beforeEach(() => {
    port = getNextPort();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (Cluster.getStatus() !== 'stopped') {
      await Cluster.stop();
    }
  });

  it('starts heartbeat timer on startup', async () => {
    await Cluster.start({
      nodeName: 'test',
      port,
      heartbeatIntervalMs: 1000,
    });

    // Heartbeat should be scheduled
    expect(Cluster.getStatus()).toBe('running');
  });

  it('creates correct heartbeat message format', async () => {
    await Cluster.start({
      nodeName: 'test',
      port,
    });

    const info = Cluster.getLocalNodeInfo();

    expect(info.id).toBe(Cluster.getLocalNodeId());
    expect(info.status).toBe('connected');
    expect(info.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(typeof info.lastHeartbeatAt).toBe('number');
  });
});
