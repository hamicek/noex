import { describe, it, expect, beforeEach } from 'vitest';
import { MonitorRegistry } from '../../../src/distribution/monitor/monitor-registry.js';
import { generateMonitorId } from '../../../src/distribution/serialization.js';
import { NodeId } from '../../../src/distribution/node-id.js';
import type { MonitorId, SerializedRef } from '../../../src/distribution/types.js';

describe('MonitorRegistry', () => {
  let registry: MonitorRegistry;
  let nodeId1: ReturnType<typeof NodeId.parse>;
  let nodeId2: ReturnType<typeof NodeId.parse>;
  let localNodeId: ReturnType<typeof NodeId.parse>;

  beforeEach(() => {
    registry = new MonitorRegistry();
    nodeId1 = NodeId.parse('node1@127.0.0.1:4369');
    nodeId2 = NodeId.parse('node2@127.0.0.1:4370');
    localNodeId = NodeId.parse('local@127.0.0.1:4371');
  });

  const createSerializedRef = (id: string, nodeId: ReturnType<typeof NodeId.parse>): SerializedRef => ({
    id,
    nodeId,
  });

  // ==========================================================================
  // Outgoing Monitor Tests
  // ==========================================================================

  describe('outgoing monitors', () => {
    describe('addOutgoing', () => {
      it('adds an outgoing monitor successfully', () => {
        const monitorId = generateMonitorId();
        const monitoredRef = createSerializedRef('remoteServer', nodeId1);

        const added = registry.addOutgoing({
          monitorId,
          monitoringServerId: 'localServer',
          monitoredRef,
          createdAt: Date.now(),
        });

        expect(added).toBe(true);
        expect(registry.outgoingCount).toBe(1);
      });

      it('returns false for duplicate monitorId', () => {
        const monitorId = generateMonitorId();
        const monitoredRef = createSerializedRef('remoteServer', nodeId1);

        registry.addOutgoing({
          monitorId,
          monitoringServerId: 'localServer1',
          monitoredRef,
          createdAt: Date.now(),
        });

        const addedAgain = registry.addOutgoing({
          monitorId,
          monitoringServerId: 'localServer2',
          monitoredRef,
          createdAt: Date.now(),
        });

        expect(addedAgain).toBe(false);
        expect(registry.outgoingCount).toBe(1);
      });

      it('tracks multiple outgoing monitors', () => {
        for (let i = 0; i < 5; i++) {
          registry.addOutgoing({
            monitorId: generateMonitorId(),
            monitoringServerId: `localServer${i}`,
            monitoredRef: createSerializedRef(`remoteServer${i}`, nodeId1),
            createdAt: Date.now(),
          });
        }

        expect(registry.outgoingCount).toBe(5);
      });
    });

    describe('getOutgoing', () => {
      it('returns monitor for valid monitorId', () => {
        const monitorId = generateMonitorId();
        const monitoredRef = createSerializedRef('remoteServer', nodeId1);
        const createdAt = Date.now();

        registry.addOutgoing({
          monitorId,
          monitoringServerId: 'localServer',
          monitoredRef,
          createdAt,
        });

        const monitor = registry.getOutgoing(monitorId);

        expect(monitor).toBeDefined();
        expect(monitor?.monitorId).toBe(monitorId);
        expect(monitor?.monitoringServerId).toBe('localServer');
        expect(monitor?.monitoredRef).toEqual(monitoredRef);
        expect(monitor?.createdAt).toBe(createdAt);
      });

      it('returns undefined for unknown monitorId', () => {
        const unknownId = generateMonitorId();
        expect(registry.getOutgoing(unknownId)).toBeUndefined();
      });
    });

    describe('removeOutgoing', () => {
      it('removes and returns monitor', () => {
        const monitorId = generateMonitorId();
        registry.addOutgoing({
          monitorId,
          monitoringServerId: 'localServer',
          monitoredRef: createSerializedRef('remoteServer', nodeId1),
          createdAt: Date.now(),
        });

        const removed = registry.removeOutgoing(monitorId);

        expect(removed).toBeDefined();
        expect(removed?.monitorId).toBe(monitorId);
        expect(registry.outgoingCount).toBe(0);
        expect(registry.getOutgoing(monitorId)).toBeUndefined();
      });

      it('returns undefined for unknown monitorId', () => {
        const unknownId = generateMonitorId();
        expect(registry.removeOutgoing(unknownId)).toBeUndefined();
      });

      it('cleans up all indexes', () => {
        const monitorId = generateMonitorId();
        registry.addOutgoing({
          monitorId,
          monitoringServerId: 'localServer',
          monitoredRef: createSerializedRef('remoteServer', nodeId1),
          createdAt: Date.now(),
        });

        registry.removeOutgoing(monitorId);

        // Verify indexes are clean by checking queries return empty
        expect(registry.getOutgoingByMonitoringServer('localServer')).toHaveLength(0);
      });
    });

    describe('removeOutgoingByNode', () => {
      it('removes all monitors to a specific node', () => {
        // Add monitors to node1
        const monitor1 = generateMonitorId();
        const monitor2 = generateMonitorId();
        registry.addOutgoing({
          monitorId: monitor1,
          monitoringServerId: 'local1',
          monitoredRef: createSerializedRef('remote1', nodeId1),
          createdAt: Date.now(),
        });
        registry.addOutgoing({
          monitorId: monitor2,
          monitoringServerId: 'local2',
          monitoredRef: createSerializedRef('remote2', nodeId1),
          createdAt: Date.now(),
        });

        // Add monitor to different node
        const monitor3 = generateMonitorId();
        registry.addOutgoing({
          monitorId: monitor3,
          monitoringServerId: 'local3',
          monitoredRef: createSerializedRef('remote3', nodeId2),
          createdAt: Date.now(),
        });

        const removed = registry.removeOutgoingByNode(nodeId1);

        expect(removed).toHaveLength(2);
        expect(registry.outgoingCount).toBe(1);
        expect(registry.getOutgoing(monitor3)).toBeDefined();
      });

      it('returns empty array when no monitors for node', () => {
        const unknownNode = NodeId.parse('unknown@127.0.0.1:9999');
        const removed = registry.removeOutgoingByNode(unknownNode);

        expect(removed).toHaveLength(0);
      });

      it('updates nodeDisconnectRemovals stats', () => {
        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: 'local',
          monitoredRef: createSerializedRef('remote', nodeId1),
          createdAt: Date.now(),
        });

        registry.removeOutgoingByNode(nodeId1);

        const stats = registry.getStats();
        expect(stats.nodeDisconnectRemovals).toBe(1);
      });
    });

    describe('removeOutgoingByMonitoringServer', () => {
      it('removes all monitors from a monitoring server', () => {
        const serverId = 'localServer';

        // Add multiple monitors from same server
        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: serverId,
          monitoredRef: createSerializedRef('remote1', nodeId1),
          createdAt: Date.now(),
        });
        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: serverId,
          monitoredRef: createSerializedRef('remote2', nodeId2),
          createdAt: Date.now(),
        });

        // Add monitor from different server
        const keepMonitorId = generateMonitorId();
        registry.addOutgoing({
          monitorId: keepMonitorId,
          monitoringServerId: 'otherServer',
          monitoredRef: createSerializedRef('remote3', nodeId1),
          createdAt: Date.now(),
        });

        const removed = registry.removeOutgoingByMonitoringServer(serverId);

        expect(removed).toHaveLength(2);
        expect(registry.outgoingCount).toBe(1);
        expect(registry.getOutgoing(keepMonitorId)).toBeDefined();
      });

      it('updates processTerminationRemovals stats', () => {
        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: 'local',
          monitoredRef: createSerializedRef('remote', nodeId1),
          createdAt: Date.now(),
        });

        registry.removeOutgoingByMonitoringServer('local');

        const stats = registry.getStats();
        expect(stats.processTerminationRemovals).toBe(1);
      });
    });

    describe('getOutgoingByMonitoringServer', () => {
      it('returns all monitors for a monitoring server', () => {
        const serverId = 'localServer';

        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: serverId,
          monitoredRef: createSerializedRef('remote1', nodeId1),
          createdAt: Date.now(),
        });
        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: serverId,
          monitoredRef: createSerializedRef('remote2', nodeId2),
          createdAt: Date.now(),
        });
        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: 'otherServer',
          monitoredRef: createSerializedRef('remote3', nodeId1),
          createdAt: Date.now(),
        });

        const monitors = registry.getOutgoingByMonitoringServer(serverId);

        expect(monitors).toHaveLength(2);
        expect(monitors.every(m => m.monitoringServerId === serverId)).toBe(true);
      });

      it('returns empty array for unknown server', () => {
        const monitors = registry.getOutgoingByMonitoringServer('unknown');
        expect(monitors).toHaveLength(0);
      });
    });
  });

  // ==========================================================================
  // Incoming Monitor Tests
  // ==========================================================================

  describe('incoming monitors', () => {
    describe('addIncoming', () => {
      it('adds an incoming monitor successfully', () => {
        const monitorId = generateMonitorId();
        const monitoringRef = createSerializedRef('remoteMonitor', nodeId1);

        const added = registry.addIncoming({
          monitorId,
          monitoringRef,
          monitoredServerId: 'localServer',
          createdAt: Date.now(),
        });

        expect(added).toBe(true);
        expect(registry.incomingCount).toBe(1);
      });

      it('returns false for duplicate monitorId', () => {
        const monitorId = generateMonitorId();

        registry.addIncoming({
          monitorId,
          monitoringRef: createSerializedRef('remote1', nodeId1),
          monitoredServerId: 'local1',
          createdAt: Date.now(),
        });

        const addedAgain = registry.addIncoming({
          monitorId,
          monitoringRef: createSerializedRef('remote2', nodeId2),
          monitoredServerId: 'local2',
          createdAt: Date.now(),
        });

        expect(addedAgain).toBe(false);
        expect(registry.incomingCount).toBe(1);
      });
    });

    describe('getIncoming', () => {
      it('returns monitor for valid monitorId', () => {
        const monitorId = generateMonitorId();
        const monitoringRef = createSerializedRef('remoteMonitor', nodeId1);
        const createdAt = Date.now();

        registry.addIncoming({
          monitorId,
          monitoringRef,
          monitoredServerId: 'localServer',
          createdAt,
        });

        const monitor = registry.getIncoming(monitorId);

        expect(monitor).toBeDefined();
        expect(monitor?.monitorId).toBe(monitorId);
        expect(monitor?.monitoringRef).toEqual(monitoringRef);
        expect(monitor?.monitoredServerId).toBe('localServer');
        expect(monitor?.createdAt).toBe(createdAt);
      });

      it('returns undefined for unknown monitorId', () => {
        const unknownId = generateMonitorId();
        expect(registry.getIncoming(unknownId)).toBeUndefined();
      });
    });

    describe('removeIncoming', () => {
      it('removes and returns monitor', () => {
        const monitorId = generateMonitorId();
        registry.addIncoming({
          monitorId,
          monitoringRef: createSerializedRef('remote', nodeId1),
          monitoredServerId: 'local',
          createdAt: Date.now(),
        });

        const removed = registry.removeIncoming(monitorId);

        expect(removed).toBeDefined();
        expect(removed?.monitorId).toBe(monitorId);
        expect(registry.incomingCount).toBe(0);
      });

      it('returns undefined for unknown monitorId', () => {
        const unknownId = generateMonitorId();
        expect(registry.removeIncoming(unknownId)).toBeUndefined();
      });
    });

    describe('removeIncomingByNode', () => {
      it('removes all monitors from a specific node', () => {
        // Add monitors from node1
        registry.addIncoming({
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remote1', nodeId1),
          monitoredServerId: 'local1',
          createdAt: Date.now(),
        });
        registry.addIncoming({
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remote2', nodeId1),
          monitoredServerId: 'local2',
          createdAt: Date.now(),
        });

        // Add monitor from different node
        const keepMonitorId = generateMonitorId();
        registry.addIncoming({
          monitorId: keepMonitorId,
          monitoringRef: createSerializedRef('remote3', nodeId2),
          monitoredServerId: 'local3',
          createdAt: Date.now(),
        });

        const removed = registry.removeIncomingByNode(nodeId1);

        expect(removed).toHaveLength(2);
        expect(registry.incomingCount).toBe(1);
        expect(registry.getIncoming(keepMonitorId)).toBeDefined();
      });

      it('returns empty array when no monitors from node', () => {
        const unknownNode = NodeId.parse('unknown@127.0.0.1:9999');
        const removed = registry.removeIncomingByNode(unknownNode);

        expect(removed).toHaveLength(0);
      });
    });

    describe('getIncomingByMonitoredServer', () => {
      it('returns all incoming monitors for a local server', () => {
        const serverId = 'localServer';

        registry.addIncoming({
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remote1', nodeId1),
          monitoredServerId: serverId,
          createdAt: Date.now(),
        });
        registry.addIncoming({
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remote2', nodeId2),
          monitoredServerId: serverId,
          createdAt: Date.now(),
        });
        registry.addIncoming({
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remote3', nodeId1),
          monitoredServerId: 'otherServer',
          createdAt: Date.now(),
        });

        const monitors = registry.getIncomingByMonitoredServer(serverId);

        expect(monitors).toHaveLength(2);
        expect(monitors.every(m => m.monitoredServerId === serverId)).toBe(true);
      });

      it('returns empty array for unknown server', () => {
        const monitors = registry.getIncomingByMonitoredServer('unknown');
        expect(monitors).toHaveLength(0);
      });
    });

    describe('removeIncomingByMonitoredServer', () => {
      it('removes all monitors for a local server', () => {
        const serverId = 'localServer';

        registry.addIncoming({
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remote1', nodeId1),
          monitoredServerId: serverId,
          createdAt: Date.now(),
        });
        registry.addIncoming({
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remote2', nodeId2),
          monitoredServerId: serverId,
          createdAt: Date.now(),
        });

        const keepMonitorId = generateMonitorId();
        registry.addIncoming({
          monitorId: keepMonitorId,
          monitoringRef: createSerializedRef('remote3', nodeId1),
          monitoredServerId: 'otherServer',
          createdAt: Date.now(),
        });

        const removed = registry.removeIncomingByMonitoredServer(serverId);

        expect(removed).toHaveLength(2);
        expect(registry.incomingCount).toBe(1);
        expect(registry.getIncoming(keepMonitorId)).toBeDefined();
      });

      it('updates processTerminationRemovals stats', () => {
        registry.addIncoming({
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remote', nodeId1),
          monitoredServerId: 'local',
          createdAt: Date.now(),
        });

        registry.removeIncomingByMonitoredServer('local');

        const stats = registry.getStats();
        expect(stats.processTerminationRemovals).toBe(1);
      });
    });
  });

  // ==========================================================================
  // General Query Operations
  // ==========================================================================

  describe('query operations', () => {
    describe('size', () => {
      it('returns total count of all monitors', () => {
        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: 'local1',
          monitoredRef: createSerializedRef('remote1', nodeId1),
          createdAt: Date.now(),
        });
        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: 'local2',
          monitoredRef: createSerializedRef('remote2', nodeId2),
          createdAt: Date.now(),
        });
        registry.addIncoming({
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remote3', nodeId1),
          monitoredServerId: 'local3',
          createdAt: Date.now(),
        });

        expect(registry.size).toBe(3);
        expect(registry.outgoingCount).toBe(2);
        expect(registry.incomingCount).toBe(1);
      });
    });

    describe('has', () => {
      it('returns true for existing outgoing monitor', () => {
        const monitorId = generateMonitorId();
        registry.addOutgoing({
          monitorId,
          monitoringServerId: 'local',
          monitoredRef: createSerializedRef('remote', nodeId1),
          createdAt: Date.now(),
        });

        expect(registry.has(monitorId)).toBe(true);
      });

      it('returns true for existing incoming monitor', () => {
        const monitorId = generateMonitorId();
        registry.addIncoming({
          monitorId,
          monitoringRef: createSerializedRef('remote', nodeId1),
          monitoredServerId: 'local',
          createdAt: Date.now(),
        });

        expect(registry.has(monitorId)).toBe(true);
      });

      it('returns false for unknown monitorId', () => {
        const unknownId = generateMonitorId();
        expect(registry.has(unknownId)).toBe(false);
      });
    });

    describe('clear', () => {
      it('removes all monitors', () => {
        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: 'local',
          monitoredRef: createSerializedRef('remote', nodeId1),
          createdAt: Date.now(),
        });
        registry.addIncoming({
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remote', nodeId1),
          monitoredServerId: 'local',
          createdAt: Date.now(),
        });

        registry.clear();

        expect(registry.size).toBe(0);
        expect(registry.outgoingCount).toBe(0);
        expect(registry.incomingCount).toBe(0);
      });
    });
  });

  // ==========================================================================
  // Statistics
  // ==========================================================================

  describe('getStats', () => {
    it('returns initial stats', () => {
      const stats = registry.getStats();

      expect(stats.outgoingCount).toBe(0);
      expect(stats.incomingCount).toBe(0);
      expect(stats.totalAdded).toBe(0);
      expect(stats.totalRemoved).toBe(0);
      expect(stats.nodeDisconnectRemovals).toBe(0);
      expect(stats.processTerminationRemovals).toBe(0);
    });

    it('tracks totalAdded correctly', () => {
      registry.addOutgoing({
        monitorId: generateMonitorId(),
        monitoringServerId: 'local',
        monitoredRef: createSerializedRef('remote', nodeId1),
        createdAt: Date.now(),
      });
      registry.addIncoming({
        monitorId: generateMonitorId(),
        monitoringRef: createSerializedRef('remote', nodeId1),
        monitoredServerId: 'local',
        createdAt: Date.now(),
      });

      const stats = registry.getStats();
      expect(stats.totalAdded).toBe(2);
    });

    it('tracks totalRemoved correctly', () => {
      const outMonitorId = generateMonitorId();
      const inMonitorId = generateMonitorId();

      registry.addOutgoing({
        monitorId: outMonitorId,
        monitoringServerId: 'local',
        monitoredRef: createSerializedRef('remote', nodeId1),
        createdAt: Date.now(),
      });
      registry.addIncoming({
        monitorId: inMonitorId,
        monitoringRef: createSerializedRef('remote', nodeId1),
        monitoredServerId: 'local',
        createdAt: Date.now(),
      });

      registry.removeOutgoing(outMonitorId);
      registry.removeIncoming(inMonitorId);

      const stats = registry.getStats();
      expect(stats.totalRemoved).toBe(2);
    });
  });

  // ==========================================================================
  // Edge Cases and Complex Scenarios
  // ==========================================================================

  describe('complex scenarios', () => {
    it('handles same server monitoring multiple remote servers', () => {
      const localServerId = 'myServer';

      registry.addOutgoing({
        monitorId: generateMonitorId(),
        monitoringServerId: localServerId,
        monitoredRef: createSerializedRef('remote1', nodeId1),
        createdAt: Date.now(),
      });
      registry.addOutgoing({
        monitorId: generateMonitorId(),
        monitoringServerId: localServerId,
        monitoredRef: createSerializedRef('remote2', nodeId1),
        createdAt: Date.now(),
      });
      registry.addOutgoing({
        monitorId: generateMonitorId(),
        monitoringServerId: localServerId,
        monitoredRef: createSerializedRef('remote3', nodeId2),
        createdAt: Date.now(),
      });

      const monitors = registry.getOutgoingByMonitoringServer(localServerId);
      expect(monitors).toHaveLength(3);
    });

    it('handles multiple remote nodes monitoring same local server', () => {
      const localServerId = 'targetServer';

      registry.addIncoming({
        monitorId: generateMonitorId(),
        monitoringRef: createSerializedRef('watcher1', nodeId1),
        monitoredServerId: localServerId,
        createdAt: Date.now(),
      });
      registry.addIncoming({
        monitorId: generateMonitorId(),
        monitoringRef: createSerializedRef('watcher2', nodeId1),
        monitoredServerId: localServerId,
        createdAt: Date.now(),
      });
      registry.addIncoming({
        monitorId: generateMonitorId(),
        monitoringRef: createSerializedRef('watcher3', nodeId2),
        monitoredServerId: localServerId,
        createdAt: Date.now(),
      });

      const monitors = registry.getIncomingByMonitoredServer(localServerId);
      expect(monitors).toHaveLength(3);
    });

    it('correctly handles node disconnect cleanup for both directions', () => {
      // Outgoing monitors to node1 (we're monitoring their processes)
      registry.addOutgoing({
        monitorId: generateMonitorId(),
        monitoringServerId: 'local1',
        monitoredRef: createSerializedRef('remote1', nodeId1),
        createdAt: Date.now(),
      });

      // Incoming monitors from node1 (they're monitoring our processes)
      registry.addIncoming({
        monitorId: generateMonitorId(),
        monitoringRef: createSerializedRef('watcher1', nodeId1),
        monitoredServerId: 'localTarget1',
        createdAt: Date.now(),
      });

      // Monitors involving node2 should be unaffected
      registry.addOutgoing({
        monitorId: generateMonitorId(),
        monitoringServerId: 'local2',
        monitoredRef: createSerializedRef('remote2', nodeId2),
        createdAt: Date.now(),
      });
      registry.addIncoming({
        monitorId: generateMonitorId(),
        monitoringRef: createSerializedRef('watcher2', nodeId2),
        monitoredServerId: 'localTarget2',
        createdAt: Date.now(),
      });

      // Simulate node1 going down
      const outgoingRemoved = registry.removeOutgoingByNode(nodeId1);
      const incomingRemoved = registry.removeIncomingByNode(nodeId1);

      expect(outgoingRemoved).toHaveLength(1);
      expect(incomingRemoved).toHaveLength(1);
      expect(registry.outgoingCount).toBe(1);
      expect(registry.incomingCount).toBe(1);
    });

    it('handles rapid add/remove cycles', () => {
      const monitorIds: MonitorId[] = [];

      // Add 100 monitors
      for (let i = 0; i < 100; i++) {
        const monitorId = generateMonitorId();
        monitorIds.push(monitorId);
        registry.addOutgoing({
          monitorId,
          monitoringServerId: `local${i % 10}`,
          monitoredRef: createSerializedRef(`remote${i}`, i % 2 === 0 ? nodeId1 : nodeId2),
          createdAt: Date.now(),
        });
      }

      expect(registry.outgoingCount).toBe(100);

      // Remove half
      for (let i = 0; i < 50; i++) {
        registry.removeOutgoing(monitorIds[i]);
      }

      expect(registry.outgoingCount).toBe(50);

      // Add more
      for (let i = 0; i < 25; i++) {
        registry.addOutgoing({
          monitorId: generateMonitorId(),
          monitoringServerId: `local${i}`,
          monitoredRef: createSerializedRef(`newRemote${i}`, nodeId1),
          createdAt: Date.now(),
        });
      }

      expect(registry.outgoingCount).toBe(75);
    });

    it('maintains index consistency after complex operations', () => {
      const serverId = 'testServer';

      // Add monitors
      const id1 = generateMonitorId();
      const id2 = generateMonitorId();
      const id3 = generateMonitorId();

      registry.addOutgoing({
        monitorId: id1,
        monitoringServerId: serverId,
        monitoredRef: createSerializedRef('remote1', nodeId1),
        createdAt: Date.now(),
      });
      registry.addOutgoing({
        monitorId: id2,
        monitoringServerId: serverId,
        monitoredRef: createSerializedRef('remote2', nodeId1),
        createdAt: Date.now(),
      });
      registry.addOutgoing({
        monitorId: id3,
        monitoringServerId: serverId,
        monitoredRef: createSerializedRef('remote3', nodeId2),
        createdAt: Date.now(),
      });

      // Remove by node
      registry.removeOutgoingByNode(nodeId1);

      // Verify server index is updated correctly
      const remaining = registry.getOutgoingByMonitoringServer(serverId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].monitoredRef.nodeId).toBe(nodeId2);
    });
  });
});
