import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Membership, NodeId } from '../../src/index.js';
import type { NodeInfo, NodeDownReason } from '../../src/index.js';

describe('Membership', () => {
  const localNodeId = NodeId.parse('local@127.0.0.1:4369');
  const node1Id = NodeId.parse('node1@127.0.0.1:4370');
  const node2Id = NodeId.parse('node2@127.0.0.1:4371');
  const node3Id = NodeId.parse('node3@127.0.0.1:4372');

  let membership: Membership;

  const createNodeInfo = (id: NodeId, overrides: Partial<NodeInfo> = {}): NodeInfo => ({
    id,
    host: NodeId.getHost(id),
    port: NodeId.getPort(id),
    status: 'connected',
    processCount: 0,
    lastHeartbeatAt: Date.now(),
    uptimeMs: 1000,
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    membership = new Membership({
      localNodeId,
      heartbeatIntervalMs: 1000,
      heartbeatMissThreshold: 3,
    });
  });

  afterEach(() => {
    membership.clear();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('creates membership with configuration', () => {
      expect(membership.getLocalNodeId()).toBe(localNodeId);
      expect(membership.size).toBe(0);
    });

    it('applies default configuration values', () => {
      const defaultMembership = new Membership({ localNodeId });
      expect(defaultMembership.getLocalNodeId()).toBe(localNodeId);
      defaultMembership.clear();
    });
  });

  describe('getNodes', () => {
    it('returns empty array initially', () => {
      expect(membership.getNodes()).toEqual([]);
    });

    it('returns all known nodes', () => {
      membership.updateNode(createNodeInfo(node1Id));
      membership.updateNode(createNodeInfo(node2Id));

      const nodes = membership.getNodes();
      expect(nodes.length).toBe(2);
      expect(nodes.map((n) => n.id)).toContain(node1Id);
      expect(nodes.map((n) => n.id)).toContain(node2Id);
    });
  });

  describe('getConnectedNodes', () => {
    it('returns only connected nodes', () => {
      membership.updateNode(createNodeInfo(node1Id));
      membership.updateNode(createNodeInfo(node2Id));
      membership.markNodeDown(node1Id, 'connection_closed');

      const connectedNodes = membership.getConnectedNodes();
      expect(connectedNodes.length).toBe(1);
      expect(connectedNodes[0].id).toBe(node2Id);
    });
  });

  describe('getNodeIds', () => {
    it('returns array of node identifiers', () => {
      membership.updateNode(createNodeInfo(node1Id));
      membership.updateNode(createNodeInfo(node2Id));

      const nodeIds = membership.getNodeIds();
      expect(nodeIds.length).toBe(2);
      expect(nodeIds).toContain(node1Id);
      expect(nodeIds).toContain(node2Id);
    });
  });

  describe('getNode', () => {
    it('returns node info by id', () => {
      membership.updateNode(createNodeInfo(node1Id, { processCount: 5 }));

      const node = membership.getNode(node1Id);
      expect(node).toBeDefined();
      expect(node!.id).toBe(node1Id);
      expect(node!.processCount).toBe(5);
    });

    it('returns undefined for unknown node', () => {
      expect(membership.getNode(node1Id)).toBeUndefined();
    });
  });

  describe('hasNode', () => {
    it('returns true for known node', () => {
      membership.updateNode(createNodeInfo(node1Id));
      expect(membership.hasNode(node1Id)).toBe(true);
    });

    it('returns false for unknown node', () => {
      expect(membership.hasNode(node1Id)).toBe(false);
    });
  });

  describe('isNodeConnected', () => {
    it('returns true for connected node', () => {
      membership.updateNode(createNodeInfo(node1Id));
      expect(membership.isNodeConnected(node1Id)).toBe(true);
    });

    it('returns false for disconnected node', () => {
      membership.updateNode(createNodeInfo(node1Id));
      membership.markNodeDown(node1Id, 'connection_closed');
      expect(membership.isNodeConnected(node1Id)).toBe(false);
    });

    it('returns false for unknown node', () => {
      expect(membership.isNodeConnected(node1Id)).toBe(false);
    });
  });

  describe('updateNode', () => {
    it('adds new node and emits nodeUp', () => {
      const nodeUpHandler = vi.fn();
      membership.on('nodeUp', nodeUpHandler);

      membership.updateNode(createNodeInfo(node1Id));

      expect(membership.size).toBe(1);
      expect(nodeUpHandler).toHaveBeenCalledTimes(1);
      expect(nodeUpHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: node1Id, status: 'connected' }),
      );
    });

    it('does not track local node', () => {
      membership.updateNode(createNodeInfo(localNodeId));
      expect(membership.size).toBe(0);
    });

    it('updates existing node and emits nodeUpdated', () => {
      membership.updateNode(createNodeInfo(node1Id, { processCount: 1 }));

      const nodeUpdatedHandler = vi.fn();
      membership.on('nodeUpdated', nodeUpdatedHandler);

      membership.updateNode(createNodeInfo(node1Id, { processCount: 5 }));

      expect(membership.size).toBe(1);
      expect(nodeUpdatedHandler).toHaveBeenCalledTimes(1);
      expect(nodeUpdatedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: node1Id, processCount: 5 }),
      );
    });

    it('emits nodeUp when disconnected node reconnects', () => {
      membership.updateNode(createNodeInfo(node1Id));
      membership.markNodeDown(node1Id, 'connection_closed');

      const nodeUpHandler = vi.fn();
      membership.on('nodeUp', nodeUpHandler);

      membership.updateNode(createNodeInfo(node1Id));

      expect(nodeUpHandler).toHaveBeenCalledTimes(1);
      expect(membership.isNodeConnected(node1Id)).toBe(true);
    });

    it('sets status to connected regardless of input status', () => {
      membership.updateNode(createNodeInfo(node1Id, { status: 'disconnected' }));

      const node = membership.getNode(node1Id);
      expect(node!.status).toBe('connected');
    });
  });

  describe('markNodeDown', () => {
    it('marks node as disconnected and emits nodeDown', () => {
      membership.updateNode(createNodeInfo(node1Id));

      const nodeDownHandler = vi.fn();
      membership.on('nodeDown', nodeDownHandler);

      membership.markNodeDown(node1Id, 'heartbeat_timeout');

      expect(membership.isNodeConnected(node1Id)).toBe(false);
      expect(nodeDownHandler).toHaveBeenCalledTimes(1);
      expect(nodeDownHandler).toHaveBeenCalledWith(node1Id, 'heartbeat_timeout');
    });

    it('does nothing for unknown node', () => {
      const nodeDownHandler = vi.fn();
      membership.on('nodeDown', nodeDownHandler);

      membership.markNodeDown(node1Id, 'connection_closed');

      expect(nodeDownHandler).not.toHaveBeenCalled();
    });

    it('does nothing if node is already disconnected', () => {
      membership.updateNode(createNodeInfo(node1Id));
      membership.markNodeDown(node1Id, 'connection_closed');

      const nodeDownHandler = vi.fn();
      membership.on('nodeDown', nodeDownHandler);

      membership.markNodeDown(node1Id, 'heartbeat_timeout');

      expect(nodeDownHandler).not.toHaveBeenCalled();
    });
  });

  describe('removeNode', () => {
    it('removes node from tracking', () => {
      membership.updateNode(createNodeInfo(node1Id));
      expect(membership.hasNode(node1Id)).toBe(true);

      const removed = membership.removeNode(node1Id);
      expect(removed).toBe(true);
      expect(membership.hasNode(node1Id)).toBe(false);
    });

    it('returns false for unknown node', () => {
      expect(membership.removeNode(node1Id)).toBe(false);
    });

    it('emits nodeDown for connected node', () => {
      membership.updateNode(createNodeInfo(node1Id));

      const nodeDownHandler = vi.fn();
      membership.on('nodeDown', nodeDownHandler);

      membership.removeNode(node1Id);

      expect(nodeDownHandler).toHaveBeenCalledWith(node1Id, 'graceful_shutdown');
    });

    it('does not emit nodeDown for already disconnected node', () => {
      membership.updateNode(createNodeInfo(node1Id));
      membership.markNodeDown(node1Id, 'connection_closed');

      const nodeDownHandler = vi.fn();
      membership.on('nodeDown', nodeDownHandler);

      membership.removeNode(node1Id);

      expect(nodeDownHandler).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('removes all nodes', () => {
      membership.updateNode(createNodeInfo(node1Id));
      membership.updateNode(createNodeInfo(node2Id));
      membership.updateNode(createNodeInfo(node3Id));

      expect(membership.size).toBe(3);

      membership.clear();

      expect(membership.size).toBe(0);
      expect(membership.getNodes()).toEqual([]);
    });
  });

  describe('size', () => {
    it('returns number of known nodes', () => {
      expect(membership.size).toBe(0);

      membership.updateNode(createNodeInfo(node1Id));
      expect(membership.size).toBe(1);

      membership.updateNode(createNodeInfo(node2Id));
      expect(membership.size).toBe(2);

      membership.removeNode(node1Id);
      expect(membership.size).toBe(1);
    });
  });

  describe('connectedCount', () => {
    it('returns number of connected nodes', () => {
      expect(membership.connectedCount).toBe(0);

      membership.updateNode(createNodeInfo(node1Id));
      membership.updateNode(createNodeInfo(node2Id));
      expect(membership.connectedCount).toBe(2);

      membership.markNodeDown(node1Id, 'connection_closed');
      expect(membership.connectedCount).toBe(1);
    });
  });

  describe('failure detection', () => {
    it('marks node as down after heartbeat timeout', () => {
      const nodeDownHandler = vi.fn();
      membership.on('nodeDown', nodeDownHandler);

      membership.updateNode(createNodeInfo(node1Id));

      // Wait for failure timeout (heartbeatInterval * missThreshold = 3000ms)
      vi.advanceTimersByTime(3000);

      expect(nodeDownHandler).toHaveBeenCalledWith(node1Id, 'heartbeat_timeout');
      expect(membership.isNodeConnected(node1Id)).toBe(false);
    });

    it('resets failure timer on heartbeat', () => {
      const nodeDownHandler = vi.fn();
      membership.on('nodeDown', nodeDownHandler);

      membership.updateNode(createNodeInfo(node1Id));

      // Advance halfway to failure
      vi.advanceTimersByTime(1500);

      // Receive another heartbeat
      membership.updateNode(createNodeInfo(node1Id));

      // Advance another 1500ms - should not trigger failure
      vi.advanceTimersByTime(1500);
      expect(nodeDownHandler).not.toHaveBeenCalled();

      // Advance to full timeout from last heartbeat
      vi.advanceTimersByTime(1500);
      expect(nodeDownHandler).toHaveBeenCalledTimes(1);
    });

    it('clears failure timer when node is marked down', () => {
      membership.updateNode(createNodeInfo(node1Id));

      // Mark down before timeout
      membership.markNodeDown(node1Id, 'connection_closed');

      const nodeDownHandler = vi.fn();
      membership.on('nodeDown', nodeDownHandler);

      // Advance past what would have been the timeout
      vi.advanceTimersByTime(5000);

      // Should not emit again
      expect(nodeDownHandler).not.toHaveBeenCalled();
    });

    it('clears failure timer when node is removed', () => {
      membership.updateNode(createNodeInfo(node1Id));

      // Clear nodeDown handler to avoid counting the removal event
      membership.removeAllListeners('nodeDown');
      membership.removeNode(node1Id);

      const nodeDownHandler = vi.fn();
      membership.on('nodeDown', nodeDownHandler);

      // Advance past timeout
      vi.advanceTimersByTime(5000);

      expect(nodeDownHandler).not.toHaveBeenCalled();
    });
  });

  describe('multiple nodes', () => {
    it('tracks multiple nodes independently', () => {
      membership.updateNode(createNodeInfo(node1Id));
      membership.updateNode(createNodeInfo(node2Id));
      membership.updateNode(createNodeInfo(node3Id));

      expect(membership.size).toBe(3);
      expect(membership.connectedCount).toBe(3);

      membership.markNodeDown(node2Id, 'connection_closed');

      expect(membership.size).toBe(3);
      expect(membership.connectedCount).toBe(2);
      expect(membership.isNodeConnected(node1Id)).toBe(true);
      expect(membership.isNodeConnected(node2Id)).toBe(false);
      expect(membership.isNodeConnected(node3Id)).toBe(true);
    });

    it('handles independent failure detection for each node', () => {
      const nodeDownHandler = vi.fn();
      membership.on('nodeDown', nodeDownHandler);

      membership.updateNode(createNodeInfo(node1Id));

      vi.advanceTimersByTime(1000);

      membership.updateNode(createNodeInfo(node2Id));

      vi.advanceTimersByTime(1000);

      membership.updateNode(createNodeInfo(node3Id));

      // At this point:
      // - node1 is at 2000ms (1000ms left to timeout)
      // - node2 is at 1000ms (2000ms left to timeout)
      // - node3 is at 0ms (3000ms left to timeout)

      vi.advanceTimersByTime(1000);

      // node1 should timeout
      expect(nodeDownHandler).toHaveBeenCalledTimes(1);
      expect(nodeDownHandler).toHaveBeenCalledWith(node1Id, 'heartbeat_timeout');

      vi.advanceTimersByTime(1000);

      // node2 should timeout
      expect(nodeDownHandler).toHaveBeenCalledTimes(2);
      expect(nodeDownHandler).toHaveBeenCalledWith(node2Id, 'heartbeat_timeout');

      vi.advanceTimersByTime(1000);

      // node3 should timeout
      expect(nodeDownHandler).toHaveBeenCalledTimes(3);
      expect(nodeDownHandler).toHaveBeenCalledWith(node3Id, 'heartbeat_timeout');
    });
  });

  describe('event handling', () => {
    it('supports multiple event listeners', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      membership.on('nodeUp', handler1);
      membership.on('nodeUp', handler2);

      membership.updateNode(createNodeInfo(node1Id));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('allows removing event listeners', () => {
      const handler = vi.fn();

      membership.on('nodeUp', handler);
      membership.updateNode(createNodeInfo(node1Id));

      membership.off('nodeUp', handler);
      membership.updateNode(createNodeInfo(node2Id));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
