import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GlobalRegistry,
  GlobalNameConflictError,
  GlobalNameNotFoundError,
} from '../../../src/distribution/registry/global-registry.js';
import { NodeId } from '../../../src/distribution/node-id.js';
import type {
  SerializedRef,
  RegistrySyncMessage,
  RegistrySyncEntry,
  NodeId as NodeIdType,
} from '../../../src/distribution/types.js';
import { Cluster } from '../../../src/distribution/cluster/cluster.js';

// =============================================================================
// Mocks
// =============================================================================

// Mock Cluster to avoid actual network operations
vi.mock('../../../src/distribution/cluster/cluster.js', () => {
  const nodeUpHandlers: Array<(node: { id: NodeIdType }) => void> = [];
  const nodeDownHandlers: Array<(nodeId: NodeIdType, reason: string) => void> = [];

  // Shared mock transport instance
  const mockTransport = {
    broadcast: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };

  const mockCluster = {
    getLocalNodeId: vi.fn(() => NodeId.parse('local@127.0.0.1:4369')),
    getStatus: vi.fn(() => 'running'),
    onNodeUp: vi.fn((handler: (node: { id: NodeIdType }) => void) => {
      nodeUpHandlers.push(handler);
      return () => {
        const idx = nodeUpHandlers.indexOf(handler);
        if (idx !== -1) nodeUpHandlers.splice(idx, 1);
      };
    }),
    onNodeDown: vi.fn((handler: (nodeId: NodeIdType, reason: string) => void) => {
      nodeDownHandlers.push(handler);
      return () => {
        const idx = nodeDownHandlers.indexOf(handler);
        if (idx !== -1) nodeDownHandlers.splice(idx, 1);
      };
    }),
    _getTransport: vi.fn(() => mockTransport),
    // Test helpers to simulate cluster events
    _simulateNodeUp: (node: { id: NodeIdType }) => {
      nodeUpHandlers.forEach(h => h(node));
    },
    _simulateNodeDown: (nodeId: NodeIdType, reason: string) => {
      nodeDownHandlers.forEach(h => h(nodeId, reason));
    },
    _clearHandlers: () => {
      nodeUpHandlers.length = 0;
      nodeDownHandlers.length = 0;
    },
    _resetTransport: () => {
      mockTransport.broadcast.mockClear();
      mockTransport.send.mockClear();
    },
  };

  return { Cluster: mockCluster };
});

// =============================================================================
// Test Helpers
// =============================================================================

function createRef(id: string, nodeId: string): SerializedRef {
  return {
    id,
    nodeId: NodeId.parse(nodeId),
  };
}

function createSyncEntry(
  name: string,
  ref: SerializedRef,
  registeredAt = Date.now(),
  priority = 0,
): RegistrySyncEntry {
  return { name, ref, registeredAt, priority };
}

// =============================================================================
// Tests
// =============================================================================

describe('GlobalRegistry', () => {
  beforeEach(() => {
    GlobalRegistry._reset();
    vi.clearAllMocks();
    (Cluster as any)._clearHandlers();
    (Cluster as any)._resetTransport();
  });

  afterEach(() => {
    GlobalRegistry._reset();
    vi.clearAllMocks();
  });

  describe('register', () => {
    it('registers a new name successfully', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');

      await GlobalRegistry.register('my-service', ref);

      expect(GlobalRegistry.isRegistered('my-service')).toBe(true);
      expect(GlobalRegistry.count()).toBe(1);
    });

    it('stores correct reference information', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');

      await GlobalRegistry.register('my-service', ref);

      const retrieved = GlobalRegistry.lookup('my-service');
      expect(retrieved.id).toBe('server1');
      expect(retrieved.nodeId).toBe(ref.nodeId);
    });

    it('throws GlobalNameConflictError for duplicate name', async () => {
      const ref1 = createRef('server1', 'local@127.0.0.1:4369');
      const ref2 = createRef('server2', 'local@127.0.0.1:4369');

      await GlobalRegistry.register('my-service', ref1);

      await expect(GlobalRegistry.register('my-service', ref2)).rejects.toThrow(
        GlobalNameConflictError,
      );
    });

    it('allows re-registration of same ref', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');

      await GlobalRegistry.register('my-service', ref);
      await GlobalRegistry.register('my-service', ref); // Should not throw

      expect(GlobalRegistry.count()).toBe(1);
    });

    it('registers multiple different names', async () => {
      const ref1 = createRef('server1', 'local@127.0.0.1:4369');
      const ref2 = createRef('server2', 'local@127.0.0.1:4369');
      const ref3 = createRef('server3', 'local@127.0.0.1:4369');

      await GlobalRegistry.register('service-a', ref1);
      await GlobalRegistry.register('service-b', ref2);
      await GlobalRegistry.register('service-c', ref3);

      expect(GlobalRegistry.count()).toBe(3);
      expect(GlobalRegistry.getNames()).toContain('service-a');
      expect(GlobalRegistry.getNames()).toContain('service-b');
      expect(GlobalRegistry.getNames()).toContain('service-c');
    });

    it('emits registered event', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');
      const eventHandler = vi.fn();

      GlobalRegistry.on('registered', eventHandler);
      await GlobalRegistry.register('my-service', ref);

      expect(eventHandler).toHaveBeenCalledWith('my-service', ref);
    });

    it('broadcasts registration to connected nodes', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');
      const transport = (Cluster as any)._getTransport();

      await GlobalRegistry.register('my-service', ref);

      expect(transport.broadcast).toHaveBeenCalled();
    });
  });

  describe('unregister', () => {
    it('removes a registered name', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');

      await GlobalRegistry.register('my-service', ref);
      expect(GlobalRegistry.isRegistered('my-service')).toBe(true);

      await GlobalRegistry.unregister('my-service');
      expect(GlobalRegistry.isRegistered('my-service')).toBe(false);
    });

    it('does nothing for non-existent name', async () => {
      await GlobalRegistry.unregister('nonexistent');
      expect(GlobalRegistry.count()).toBe(0);
    });

    it('does not unregister remote registration', async () => {
      const remoteRef = createRef('server1', 'remote@192.168.1.2:4369');

      // Simulate receiving a remote registration
      const syncMessage: RegistrySyncMessage = {
        type: 'registry_sync',
        entries: [createSyncEntry('remote-service', remoteRef)],
        fullSync: false,
      };

      GlobalRegistry.handleRegistrySync(syncMessage, NodeId.parse('remote@192.168.1.2:4369'));

      // Try to unregister from local node
      await GlobalRegistry.unregister('remote-service');

      // Should still be registered (only owner can unregister)
      expect(GlobalRegistry.isRegistered('remote-service')).toBe(true);
    });

    it('emits unregistered event', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');
      const eventHandler = vi.fn();

      await GlobalRegistry.register('my-service', ref);

      GlobalRegistry.on('unregistered', eventHandler);
      await GlobalRegistry.unregister('my-service');

      expect(eventHandler).toHaveBeenCalledWith('my-service', ref);
    });
  });

  describe('lookup', () => {
    it('returns registered reference', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');

      await GlobalRegistry.register('my-service', ref);

      const result = GlobalRegistry.lookup('my-service');
      expect(result).toEqual(ref);
    });

    it('throws GlobalNameNotFoundError for unknown name', () => {
      expect(() => GlobalRegistry.lookup('unknown')).toThrow(GlobalNameNotFoundError);
    });

    it('throws error with name in message', () => {
      try {
        GlobalRegistry.lookup('missing-service');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GlobalNameNotFoundError);
        expect((error as GlobalNameNotFoundError).registryName).toBe('missing-service');
      }
    });
  });

  describe('whereis', () => {
    it('returns registered reference', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');

      await GlobalRegistry.register('my-service', ref);

      const result = GlobalRegistry.whereis('my-service');
      expect(result).toEqual(ref);
    });

    it('returns undefined for unknown name', () => {
      const result = GlobalRegistry.whereis('unknown');
      expect(result).toBeUndefined();
    });

    it('works before initialization', () => {
      // whereis should not throw even if not initialized
      GlobalRegistry._reset();
      const result = GlobalRegistry.whereis('anything');
      expect(result).toBeUndefined();
    });
  });

  describe('isRegistered', () => {
    it('returns true for registered name', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');

      await GlobalRegistry.register('my-service', ref);

      expect(GlobalRegistry.isRegistered('my-service')).toBe(true);
    });

    it('returns false for unregistered name', () => {
      expect(GlobalRegistry.isRegistered('unknown')).toBe(false);
    });
  });

  describe('getNames', () => {
    it('returns empty array when no registrations', () => {
      expect(GlobalRegistry.getNames()).toEqual([]);
    });

    it('returns all registered names', async () => {
      await GlobalRegistry.register('a', createRef('s1', 'local@127.0.0.1:4369'));
      await GlobalRegistry.register('b', createRef('s2', 'local@127.0.0.1:4369'));
      await GlobalRegistry.register('c', createRef('s3', 'local@127.0.0.1:4369'));

      const names = GlobalRegistry.getNames();
      expect(names).toHaveLength(3);
      expect(names).toContain('a');
      expect(names).toContain('b');
      expect(names).toContain('c');
    });
  });

  describe('count', () => {
    it('returns 0 when empty', () => {
      expect(GlobalRegistry.count()).toBe(0);
    });

    it('returns correct count', async () => {
      await GlobalRegistry.register('a', createRef('s1', 'local@127.0.0.1:4369'));
      expect(GlobalRegistry.count()).toBe(1);

      await GlobalRegistry.register('b', createRef('s2', 'local@127.0.0.1:4369'));
      expect(GlobalRegistry.count()).toBe(2);

      await GlobalRegistry.unregister('a');
      expect(GlobalRegistry.count()).toBe(1);
    });
  });

  describe('getEntriesForNode', () => {
    it('returns entries for specific node', async () => {
      const localNodeId = NodeId.parse('local@127.0.0.1:4369');
      const remoteNodeId = NodeId.parse('remote@192.168.1.2:4369');

      await GlobalRegistry.register('local-1', createRef('s1', 'local@127.0.0.1:4369'));
      await GlobalRegistry.register('local-2', createRef('s2', 'local@127.0.0.1:4369'));

      // Add remote entries via sync
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('remote-1', createRef('r1', 'remote@192.168.1.2:4369'))],
          fullSync: false,
        },
        remoteNodeId,
      );

      const localEntries = GlobalRegistry.getEntriesForNode(localNodeId);
      expect(localEntries).toHaveLength(2);
      expect(localEntries.map(e => e.name)).toContain('local-1');
      expect(localEntries.map(e => e.name)).toContain('local-2');

      const remoteEntries = GlobalRegistry.getEntriesForNode(remoteNodeId);
      expect(remoteEntries).toHaveLength(1);
      expect(remoteEntries[0].name).toBe('remote-1');
    });
  });

  describe('getStats', () => {
    it('returns initial stats', () => {
      const stats = GlobalRegistry.getStats();

      expect(stats.totalRegistrations).toBe(0);
      expect(stats.localRegistrations).toBe(0);
      expect(stats.remoteRegistrations).toBe(0);
      expect(stats.syncOperations).toBe(0);
      expect(stats.conflictsResolved).toBe(0);
    });

    it('tracks local registrations', async () => {
      await GlobalRegistry.register('service', createRef('s1', 'local@127.0.0.1:4369'));

      const stats = GlobalRegistry.getStats();
      expect(stats.totalRegistrations).toBe(1);
      expect(stats.localRegistrations).toBe(1);
      expect(stats.remoteRegistrations).toBe(0);
    });

    it('tracks remote registrations', () => {
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('remote', createRef('r1', 'remote@192.168.1.2:4369'))],
          fullSync: false,
        },
        NodeId.parse('remote@192.168.1.2:4369'),
      );

      const stats = GlobalRegistry.getStats();
      expect(stats.totalRegistrations).toBe(1);
      expect(stats.localRegistrations).toBe(0);
      expect(stats.remoteRegistrations).toBe(1);
    });

    it('tracks sync operations', () => {
      GlobalRegistry.handleRegistrySync(
        { type: 'registry_sync', entries: [], fullSync: false },
        NodeId.parse('remote@192.168.1.2:4369'),
      );
      GlobalRegistry.handleRegistrySync(
        { type: 'registry_sync', entries: [], fullSync: true },
        NodeId.parse('remote@192.168.1.2:4369'),
      );

      const stats = GlobalRegistry.getStats();
      expect(stats.syncOperations).toBe(2);
    });
  });

  describe('handleRegistrySync', () => {
    it('adds new entries from sync', () => {
      const ref = createRef('server1', 'remote@192.168.1.2:4369');
      const syncMessage: RegistrySyncMessage = {
        type: 'registry_sync',
        entries: [createSyncEntry('remote-service', ref)],
        fullSync: false,
      };

      GlobalRegistry.handleRegistrySync(syncMessage, NodeId.parse('remote@192.168.1.2:4369'));

      expect(GlobalRegistry.isRegistered('remote-service')).toBe(true);
      expect(GlobalRegistry.lookup('remote-service')).toEqual(ref);
    });

    it('handles multiple entries in sync', () => {
      const syncMessage: RegistrySyncMessage = {
        type: 'registry_sync',
        entries: [
          createSyncEntry('service-a', createRef('s1', 'remote@192.168.1.2:4369')),
          createSyncEntry('service-b', createRef('s2', 'remote@192.168.1.2:4369')),
          createSyncEntry('service-c', createRef('s3', 'remote@192.168.1.2:4369')),
        ],
        fullSync: false,
      };

      GlobalRegistry.handleRegistrySync(syncMessage, NodeId.parse('remote@192.168.1.2:4369'));

      expect(GlobalRegistry.count()).toBe(3);
    });

    it('ignores duplicate entries with same ref', async () => {
      const ref = createRef('server1', 'local@127.0.0.1:4369');
      await GlobalRegistry.register('my-service', ref);

      const syncMessage: RegistrySyncMessage = {
        type: 'registry_sync',
        entries: [createSyncEntry('my-service', ref)],
        fullSync: false,
      };

      GlobalRegistry.handleRegistrySync(syncMessage, NodeId.parse('remote@192.168.1.2:4369'));

      // Should still have only one entry
      expect(GlobalRegistry.count()).toBe(1);
    });

    it('removes entries on full sync', () => {
      const remoteNodeId = NodeId.parse('remote@192.168.1.2:4369');

      // First sync adds entries
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [
            createSyncEntry('service-a', createRef('s1', 'remote@192.168.1.2:4369')),
            createSyncEntry('service-b', createRef('s2', 'remote@192.168.1.2:4369')),
          ],
          fullSync: true,
        },
        remoteNodeId,
      );

      expect(GlobalRegistry.count()).toBe(2);

      // Full sync with only one entry should remove the other
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('service-a', createRef('s1', 'remote@192.168.1.2:4369'))],
          fullSync: true,
        },
        remoteNodeId,
      );

      // service-b should be removed
      expect(GlobalRegistry.count()).toBe(1);
      expect(GlobalRegistry.isRegistered('service-a')).toBe(true);
      expect(GlobalRegistry.isRegistered('service-b')).toBe(false);
    });

    it('preserves local entries on remote full sync', async () => {
      const remoteNodeId = NodeId.parse('remote@192.168.1.2:4369');

      // Register local entry
      await GlobalRegistry.register('local-service', createRef('ls', 'local@127.0.0.1:4369'));

      // Receive full sync from remote
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('remote-service', createRef('rs', 'remote@192.168.1.2:4369'))],
          fullSync: true,
        },
        remoteNodeId,
      );

      // Local entry should be preserved
      expect(GlobalRegistry.isRegistered('local-service')).toBe(true);
      expect(GlobalRegistry.isRegistered('remote-service')).toBe(true);
    });

    it('emits synced event', () => {
      const eventHandler = vi.fn();
      GlobalRegistry.on('synced', eventHandler);

      const remoteNodeId = NodeId.parse('remote@192.168.1.2:4369');
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('service', createRef('s1', 'remote@192.168.1.2:4369'))],
          fullSync: false,
        },
        remoteNodeId,
      );

      expect(eventHandler).toHaveBeenCalledWith(remoteNodeId, 1);
    });
  });

  describe('conflict resolution', () => {
    it('earlier registration wins over later one', async () => {
      const earlier = Date.now() - 1000;
      const later = Date.now();

      const localRef = createRef('local', 'local@127.0.0.1:4369');
      const remoteRef = createRef('remote', 'remote@192.168.1.2:4369');

      await GlobalRegistry.register('conflict-name', localRef);

      // Receive sync with earlier timestamp - should win
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('conflict-name', remoteRef, earlier, 0)],
          fullSync: false,
        },
        NodeId.parse('remote@192.168.1.2:4369'),
      );

      const result = GlobalRegistry.lookup('conflict-name');
      expect(result).toEqual(remoteRef);
    });

    it('existing registration wins over later incoming', async () => {
      const earlier = Date.now() - 1000;

      const localRef = createRef('local', 'local@127.0.0.1:4369');
      const remoteRef = createRef('remote', 'remote@192.168.1.2:4369');

      // Register local first (will have timestamp around "earlier")
      await GlobalRegistry.register('conflict-name', localRef);

      // Receive sync with later timestamp - should lose
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('conflict-name', remoteRef, Date.now() + 1000, 0)],
          fullSync: false,
        },
        NodeId.parse('remote@192.168.1.2:4369'),
      );

      const result = GlobalRegistry.lookup('conflict-name');
      expect(result).toEqual(localRef);
    });

    it('lower priority wins as tiebreaker', () => {
      const timestamp = Date.now();

      const ref1 = createRef('s1', 'node1@192.168.1.1:4369');
      const ref2 = createRef('s2', 'node2@192.168.1.2:4369');

      // First registration
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('conflict', ref1, timestamp, 100)],
          fullSync: false,
        },
        NodeId.parse('node1@192.168.1.1:4369'),
      );

      // Second registration with same timestamp but lower priority - should win
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('conflict', ref2, timestamp, 50)],
          fullSync: false,
        },
        NodeId.parse('node2@192.168.1.2:4369'),
      );

      const result = GlobalRegistry.lookup('conflict');
      expect(result).toEqual(ref2);
    });

    it('emits conflictResolved event', async () => {
      const eventHandler = vi.fn();
      GlobalRegistry.on('conflictResolved', eventHandler);

      const localRef = createRef('local', 'local@127.0.0.1:4369');
      const remoteRef = createRef('remote', 'remote@192.168.1.2:4369');

      await GlobalRegistry.register('conflict-name', localRef);

      // Earlier timestamp wins
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('conflict-name', remoteRef, Date.now() - 1000, 0)],
          fullSync: false,
        },
        NodeId.parse('remote@192.168.1.2:4369'),
      );

      expect(eventHandler).toHaveBeenCalled();
      expect(eventHandler.mock.calls[0][0]).toBe('conflict-name');
    });

    it('tracks conflict count in stats', async () => {
      const localRef = createRef('local', 'local@127.0.0.1:4369');
      const remoteRef = createRef('remote', 'remote@192.168.1.2:4369');

      await GlobalRegistry.register('conflict-name', localRef);

      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('conflict-name', remoteRef, Date.now() - 1000, 0)],
          fullSync: false,
        },
        NodeId.parse('remote@192.168.1.2:4369'),
      );

      const stats = GlobalRegistry.getStats();
      expect(stats.conflictsResolved).toBe(1);
    });
  });

  describe('createFullSyncMessage', () => {
    it('creates message with local entries only', async () => {
      await GlobalRegistry.register('local-1', createRef('ls1', 'local@127.0.0.1:4369'));
      await GlobalRegistry.register('local-2', createRef('ls2', 'local@127.0.0.1:4369'));

      // Add remote entry
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('remote-1', createRef('rs1', 'remote@192.168.1.2:4369'))],
          fullSync: false,
        },
        NodeId.parse('remote@192.168.1.2:4369'),
      );

      const message = GlobalRegistry.createFullSyncMessage();

      expect(message.type).toBe('registry_sync');
      expect(message.fullSync).toBe(true);
      expect(message.entries).toHaveLength(2);
      expect(message.entries.map(e => e.name)).toContain('local-1');
      expect(message.entries.map(e => e.name)).toContain('local-2');
      expect(message.entries.map(e => e.name)).not.toContain('remote-1');
    });

    it('creates empty message when no local entries', () => {
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('remote', createRef('rs', 'remote@192.168.1.2:4369'))],
          fullSync: false,
        },
        NodeId.parse('remote@192.168.1.2:4369'),
      );

      const message = GlobalRegistry.createFullSyncMessage();

      expect(message.entries).toHaveLength(0);
    });
  });

  describe('node down handling', () => {
    it('removes entries from down node', async () => {
      const remoteNodeId = NodeId.parse('remote@192.168.1.2:4369');

      // Add remote entries
      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [
            createSyncEntry('remote-1', createRef('r1', 'remote@192.168.1.2:4369')),
            createSyncEntry('remote-2', createRef('r2', 'remote@192.168.1.2:4369')),
          ],
          fullSync: false,
        },
        remoteNodeId,
      );

      // Add local entry
      await GlobalRegistry.register('local', createRef('l1', 'local@127.0.0.1:4369'));

      expect(GlobalRegistry.count()).toBe(3);

      // Simulate node down
      (Cluster as any)._simulateNodeDown(remoteNodeId, 'heartbeat_timeout');

      // Remote entries should be removed
      expect(GlobalRegistry.count()).toBe(1);
      expect(GlobalRegistry.isRegistered('local')).toBe(true);
      expect(GlobalRegistry.isRegistered('remote-1')).toBe(false);
      expect(GlobalRegistry.isRegistered('remote-2')).toBe(false);
    });

    it('emits unregistered events for removed entries', async () => {
      const eventHandler = vi.fn();
      const remoteNodeId = NodeId.parse('remote@192.168.1.2:4369');

      GlobalRegistry.handleRegistrySync(
        {
          type: 'registry_sync',
          entries: [createSyncEntry('remote', createRef('r1', 'remote@192.168.1.2:4369'))],
          fullSync: false,
        },
        remoteNodeId,
      );

      GlobalRegistry.on('unregistered', eventHandler);

      // Simulate node down
      (Cluster as any)._simulateNodeDown(remoteNodeId, 'heartbeat_timeout');

      expect(eventHandler).toHaveBeenCalledWith('remote', expect.any(Object));
    });
  });

  describe('node up handling', () => {
    it('sends full sync to new node', async () => {
      await GlobalRegistry.register('local', createRef('l1', 'local@127.0.0.1:4369'));

      const transport = (Cluster as any)._getTransport();

      // Simulate new node joining
      const newNodeId = NodeId.parse('new@192.168.1.3:4369');
      (Cluster as any)._simulateNodeUp({ id: newNodeId });

      // Give time for async operation
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have sent full sync
      expect(transport.send).toHaveBeenCalled();
    });
  });

  describe('_clear', () => {
    it('clears all entries', async () => {
      await GlobalRegistry.register('a', createRef('s1', 'local@127.0.0.1:4369'));
      await GlobalRegistry.register('b', createRef('s2', 'local@127.0.0.1:4369'));

      GlobalRegistry._clear();

      expect(GlobalRegistry.count()).toBe(0);
      expect(GlobalRegistry.getNames()).toEqual([]);
    });

    it('resets stats', async () => {
      await GlobalRegistry.register('a', createRef('s1', 'local@127.0.0.1:4369'));

      GlobalRegistry.handleRegistrySync(
        { type: 'registry_sync', entries: [], fullSync: false },
        NodeId.parse('remote@192.168.1.2:4369'),
      );

      GlobalRegistry._clear();

      const stats = GlobalRegistry.getStats();
      expect(stats.syncOperations).toBe(0);
      expect(stats.conflictsResolved).toBe(0);
    });
  });

  describe('_reset', () => {
    it('clears entries and removes event listeners', async () => {
      await GlobalRegistry.register('a', createRef('s1', 'local@127.0.0.1:4369'));

      GlobalRegistry._reset();

      expect(GlobalRegistry.count()).toBe(0);
    });
  });

  describe('error types', () => {
    it('GlobalNameConflictError contains registry name and node ID', async () => {
      const ref1 = createRef('s1', 'local@127.0.0.1:4369');
      const ref2 = createRef('s2', 'local@127.0.0.1:4369');

      await GlobalRegistry.register('conflict', ref1);

      try {
        await GlobalRegistry.register('conflict', ref2);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GlobalNameConflictError);
        const err = error as GlobalNameConflictError;
        expect(err.registryName).toBe('conflict');
        expect(err.existingNodeId).toBeDefined();
      }
    });

    it('GlobalNameNotFoundError contains registry name', () => {
      try {
        GlobalRegistry.lookup('missing');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GlobalNameNotFoundError);
        const err = error as GlobalNameNotFoundError;
        expect(err.registryName).toBe('missing');
      }
    });
  });

  describe('concurrent operations', () => {
    it('handles multiple concurrent registrations', async () => {
      const registrations = Array.from({ length: 10 }, (_, i) =>
        GlobalRegistry.register(`service-${i}`, createRef(`s${i}`, 'local@127.0.0.1:4369')),
      );

      await Promise.all(registrations);

      expect(GlobalRegistry.count()).toBe(10);
    });

    it('handles concurrent sync messages', () => {
      const syncMessages = Array.from({ length: 5 }, (_, i) => ({
        type: 'registry_sync' as const,
        entries: [createSyncEntry(`remote-${i}`, createRef(`r${i}`, `node${i}@192.168.1.${i}:4369`))],
        fullSync: false,
      }));

      syncMessages.forEach((msg, i) => {
        GlobalRegistry.handleRegistrySync(msg, NodeId.parse(`node${i}@192.168.1.${i}:4369`));
      });

      expect(GlobalRegistry.count()).toBe(5);
    });
  });
});
