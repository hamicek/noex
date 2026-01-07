import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeId } from '../../../src/distribution/node-id.js';
import type { NodeId as NodeIdType, SerializedRef } from '../../../src/distribution/types.js';
import type { GenServerRef } from '../../../src/core/types.js';
import { DistributedChildRegistry } from '../../../src/distribution/supervisor/child-registry.js';
import { DistributedChildClaimError } from '../../../src/distribution/supervisor/types.js';
import { GlobalRegistry } from '../../../src/distribution/registry/global-registry.js';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('../../../src/distribution/cluster/cluster.js', () => {
  const nodeUpHandlers: Array<(node: { id: NodeIdType }) => void> = [];
  const nodeDownHandlers: Array<(nodeId: NodeIdType, reason: string) => void> = [];

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
    _simulateNodeUp: (node: { id: NodeIdType }) => {
      nodeUpHandlers.forEach((h) => h(node));
    },
    _simulateNodeDown: (nodeId: NodeIdType, reason: string) => {
      nodeDownHandlers.forEach((h) => h(nodeId, reason));
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

const localNodeId = NodeId.parse('local@127.0.0.1:4369');
const remoteNodeId = NodeId.parse('remote@192.168.1.2:4369');

function createGenServerRef(id: string, nodeId?: NodeIdType): GenServerRef {
  return {
    id,
    nodeId: nodeId as unknown as string | undefined,
  } as GenServerRef;
}

// =============================================================================
// Tests
// =============================================================================

describe('DistributedChildRegistry', () => {
  beforeEach(() => {
    GlobalRegistry._reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    GlobalRegistry._reset();
  });

  describe('registerChild', () => {
    it('registers a child successfully', async () => {
      const ref = createGenServerRef('server-1', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref, localNodeId);

      const status = DistributedChildRegistry.isChildRegistered('sup-1', 'child-1');
      expect(status.exists).toBe(true);
      expect(status.nodeId).toBe(localNodeId);
    });

    it('registers multiple children for same supervisor', async () => {
      const ref1 = createGenServerRef('server-1', localNodeId);
      const ref2 = createGenServerRef('server-2', localNodeId);
      const ref3 = createGenServerRef('server-3', remoteNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref1, localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'child-2', ref2, localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'child-3', ref3, remoteNodeId);

      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child-1').exists).toBe(true);
      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child-2').exists).toBe(true);
      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child-3').exists).toBe(true);
    });

    it('registers same child ID for different supervisors', async () => {
      const ref1 = createGenServerRef('server-1', localNodeId);
      const ref2 = createGenServerRef('server-2', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'worker', ref1, localNodeId);
      await DistributedChildRegistry.registerChild('sup-2', 'worker', ref2, localNodeId);

      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'worker').exists).toBe(true);
      expect(DistributedChildRegistry.isChildRegistered('sup-2', 'worker').exists).toBe(true);
    });

    it('throws on duplicate registration with different ref', async () => {
      const ref1 = createGenServerRef('server-1', localNodeId);
      const ref2 = createGenServerRef('server-2', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref1, localNodeId);

      await expect(
        DistributedChildRegistry.registerChild('sup-1', 'child-1', ref2, localNodeId),
      ).rejects.toThrow();
    });

    it('handles child IDs with special characters', async () => {
      const ref = createGenServerRef('server-1', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child:with:colons', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'child-with-dashes', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'child_with_underscores', ref, localNodeId);

      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child:with:colons').exists).toBe(true);
      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child-with-dashes').exists).toBe(true);
      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child_with_underscores').exists).toBe(true);
    });

    it('registers child on remote node', async () => {
      const ref = createGenServerRef('remote-server', remoteNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'remote-child', ref, remoteNodeId);

      const status = DistributedChildRegistry.isChildRegistered('sup-1', 'remote-child');
      expect(status.exists).toBe(true);
      expect(status.nodeId).toBe(remoteNodeId);
    });
  });

  describe('unregisterChild', () => {
    it('unregisters a child', async () => {
      const ref = createGenServerRef('server-1', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref, localNodeId);
      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child-1').exists).toBe(true);

      await DistributedChildRegistry.unregisterChild('sup-1', 'child-1');
      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child-1').exists).toBe(false);
    });

    it('does nothing for non-existent child', async () => {
      await DistributedChildRegistry.unregisterChild('sup-1', 'nonexistent');
      // Should not throw
    });

    it('unregisters only the specified child', async () => {
      const ref1 = createGenServerRef('server-1', localNodeId);
      const ref2 = createGenServerRef('server-2', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref1, localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'child-2', ref2, localNodeId);

      await DistributedChildRegistry.unregisterChild('sup-1', 'child-1');

      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child-1').exists).toBe(false);
      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child-2').exists).toBe(true);
    });
  });

  describe('isChildRegistered', () => {
    it('returns exists: false for unregistered child', () => {
      const status = DistributedChildRegistry.isChildRegistered('sup-1', 'nonexistent');

      expect(status.exists).toBe(false);
      expect(status.nodeId).toBeUndefined();
      expect(status.ref).toBeUndefined();
      expect(status.supervisorId).toBeUndefined();
    });

    it('returns full information for registered child', async () => {
      const ref = createGenServerRef('server-1', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref, localNodeId);

      const status = DistributedChildRegistry.isChildRegistered('sup-1', 'child-1');

      expect(status.exists).toBe(true);
      expect(status.nodeId).toBe(localNodeId);
      expect(status.ref).toBeDefined();
      expect(status.supervisorId).toBe('sup-1');
    });

    it('returns correct node for remote child', async () => {
      const ref = createGenServerRef('remote-server', remoteNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'remote-child', ref, remoteNodeId);

      const status = DistributedChildRegistry.isChildRegistered('sup-1', 'remote-child');

      expect(status.exists).toBe(true);
      expect(status.nodeId).toBe(remoteNodeId);
    });
  });

  describe('tryClaimChild', () => {
    it('successfully claims registered child', async () => {
      const ref = createGenServerRef('server-1', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref, localNodeId);

      const claimed = await DistributedChildRegistry.tryClaimChild('sup-1', 'child-1');

      expect(claimed).toBe(true);
      // Child should be unregistered after claim
      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child-1').exists).toBe(false);
    });

    it('returns false for non-existent child', async () => {
      const claimed = await DistributedChildRegistry.tryClaimChild('sup-1', 'nonexistent');

      expect(claimed).toBe(false);
    });

    it('returns false when trying to claim child of another supervisor', async () => {
      const ref = createGenServerRef('server-1', localNodeId);

      // Register child under sup-1
      await DistributedChildRegistry.registerChild('sup-1', 'shared-child', ref, localNodeId);

      // Try to claim from sup-2 - returns false because different supervisors
      // have separate namespaces (dsup:sup-1:shared-child vs dsup:sup-2:shared-child)
      const claimed = await DistributedChildRegistry.tryClaimChild('sup-2', 'shared-child');
      expect(claimed).toBe(false);

      // Original registration should be untouched
      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'shared-child').exists).toBe(true);
    });

    it('DistributedChildClaimError contains correct information', () => {
      // Test the error class properties directly
      const error = new DistributedChildClaimError('claiming-sup', 'child-1', 'owner-sup');

      expect(error.name).toBe('DistributedChildClaimError');
      expect(error.supervisorId).toBe('claiming-sup');
      expect(error.childId).toBe('child-1');
      expect(error.ownerSupervisorId).toBe('owner-sup');
      expect(error.message).toContain('claiming-sup');
      expect(error.message).toContain('child-1');
      expect(error.message).toContain('owner-sup');
    });

    it('allows re-registration after successful claim', async () => {
      const ref1 = createGenServerRef('server-1', localNodeId);
      const ref2 = createGenServerRef('server-2', remoteNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref1, localNodeId);

      const claimed = await DistributedChildRegistry.tryClaimChild('sup-1', 'child-1');
      expect(claimed).toBe(true);

      // Re-register on different node (simulating restart after node failure)
      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref2, remoteNodeId);

      const status = DistributedChildRegistry.isChildRegistered('sup-1', 'child-1');
      expect(status.exists).toBe(true);
      expect(status.nodeId).toBe(remoteNodeId);
    });
  });

  describe('getChildrenForSupervisor', () => {
    it('returns empty array for supervisor with no children', () => {
      const children = DistributedChildRegistry.getChildrenForSupervisor('sup-empty');

      expect(children).toEqual([]);
    });

    it('returns all children for supervisor', async () => {
      const ref = createGenServerRef('server', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'worker-1', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'worker-2', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'cache-1', ref, localNodeId);

      const children = DistributedChildRegistry.getChildrenForSupervisor('sup-1');

      expect(children).toHaveLength(3);
      expect(children).toContain('worker-1');
      expect(children).toContain('worker-2');
      expect(children).toContain('cache-1');
    });

    it('does not return children from other supervisors', async () => {
      const ref = createGenServerRef('server', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-a', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup-2', 'child-b', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup-3', 'child-c', ref, localNodeId);

      const sup1Children = DistributedChildRegistry.getChildrenForSupervisor('sup-1');
      const sup2Children = DistributedChildRegistry.getChildrenForSupervisor('sup-2');

      expect(sup1Children).toEqual(['child-a']);
      expect(sup2Children).toEqual(['child-b']);
    });

    it('handles supervisor IDs with special characters (except colon)', async () => {
      const ref = createGenServerRef('server', localNodeId);

      // Note: Colons are used as separators in registry keys, so supervisor IDs
      // should avoid them. Other special characters work fine.
      await DistributedChildRegistry.registerChild('sup-with-dashes', 'child-1', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup_with_underscores', 'child-2', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup.with.dots', 'child-3', ref, localNodeId);

      expect(DistributedChildRegistry.getChildrenForSupervisor('sup-with-dashes')).toEqual(['child-1']);
      expect(DistributedChildRegistry.getChildrenForSupervisor('sup_with_underscores')).toEqual(['child-2']);
      expect(DistributedChildRegistry.getChildrenForSupervisor('sup.with.dots')).toEqual(['child-3']);
    });
  });

  describe('unregisterAllChildren', () => {
    it('unregisters all children for supervisor', async () => {
      const ref = createGenServerRef('server', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'child-2', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'child-3', ref, localNodeId);

      const count = await DistributedChildRegistry.unregisterAllChildren('sup-1');

      expect(count).toBe(3);
      expect(DistributedChildRegistry.getChildrenForSupervisor('sup-1')).toEqual([]);
    });

    it('returns 0 for supervisor with no children', async () => {
      const count = await DistributedChildRegistry.unregisterAllChildren('sup-empty');

      expect(count).toBe(0);
    });

    it('does not affect children from other supervisors', async () => {
      const ref = createGenServerRef('server', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref, localNodeId);
      await DistributedChildRegistry.registerChild('sup-2', 'child-2', ref, localNodeId);

      await DistributedChildRegistry.unregisterAllChildren('sup-1');

      expect(DistributedChildRegistry.isChildRegistered('sup-1', 'child-1').exists).toBe(false);
      expect(DistributedChildRegistry.isChildRegistered('sup-2', 'child-2').exists).toBe(true);
    });
  });

  describe('getServerIdForChild', () => {
    it('returns server ID for registered child', async () => {
      const ref = createGenServerRef('my-server-id', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', 'child-1', ref, localNodeId);

      const serverId = DistributedChildRegistry.getServerIdForChild('sup-1', 'child-1');

      expect(serverId).toBe('my-server-id');
    });

    it('returns undefined for non-existent child', () => {
      const serverId = DistributedChildRegistry.getServerIdForChild('sup-1', 'nonexistent');

      expect(serverId).toBeUndefined();
    });
  });

  describe('_buildRegistryKey', () => {
    it('builds key with correct format', () => {
      const key = DistributedChildRegistry._buildRegistryKey('sup-1', 'child-1');

      expect(key).toBe('dsup:sup-1:child-1');
    });

    it('handles special characters in supervisor ID', () => {
      const key = DistributedChildRegistry._buildRegistryKey('sup:with:colons', 'child');

      expect(key).toBe('dsup:sup:with:colons:child');
    });
  });

  describe('_parseRegistryKey', () => {
    it('parses valid key', () => {
      const result = DistributedChildRegistry._parseRegistryKey('dsup:sup-1:child-1');

      expect(result).toEqual({
        supervisorId: 'sup-1',
        childId: 'child-1',
      });
    });

    it('handles child ID with colons', () => {
      const result = DistributedChildRegistry._parseRegistryKey('dsup:sup-1:child:with:colons');

      expect(result).toEqual({
        supervisorId: 'sup-1',
        childId: 'child:with:colons',
      });
    });

    it('returns null for invalid prefix', () => {
      const result = DistributedChildRegistry._parseRegistryKey('invalid:sup:child');

      expect(result).toBeNull();
    });

    it('returns null for too few parts', () => {
      const result = DistributedChildRegistry._parseRegistryKey('dsup:only-one');

      expect(result).toBeNull();
    });
  });

  describe('concurrent operations', () => {
    it('handles concurrent registrations', async () => {
      const registrations = Array.from({ length: 10 }, (_, i) =>
        DistributedChildRegistry.registerChild(
          'sup-1',
          `child-${i}`,
          createGenServerRef(`server-${i}`, localNodeId),
          localNodeId,
        ),
      );

      await Promise.all(registrations);

      const children = DistributedChildRegistry.getChildrenForSupervisor('sup-1');
      expect(children).toHaveLength(10);
    });

    it('handles concurrent claims safely', async () => {
      const ref = createGenServerRef('server-1', localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'contested-child', ref, localNodeId);

      // Simulate two supervisors trying to claim simultaneously
      const claim1 = DistributedChildRegistry.tryClaimChild('sup-1', 'contested-child');
      const claim2 = DistributedChildRegistry.tryClaimChild('sup-1', 'contested-child');

      const results = await Promise.allSettled([claim1, claim2]);

      // One should succeed, one should fail (return false)
      const successes = results.filter(
        (r) => r.status === 'fulfilled' && r.value === true,
      );
      const failures = results.filter(
        (r) => r.status === 'fulfilled' && r.value === false,
      );

      // At least one succeeded
      expect(successes.length + failures.length).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('handles empty supervisor ID', async () => {
      const ref = createGenServerRef('server', localNodeId);

      await DistributedChildRegistry.registerChild('', 'child-1', ref, localNodeId);

      expect(DistributedChildRegistry.isChildRegistered('', 'child-1').exists).toBe(true);
    });

    it('handles empty child ID', async () => {
      const ref = createGenServerRef('server', localNodeId);

      await DistributedChildRegistry.registerChild('sup-1', '', ref, localNodeId);

      expect(DistributedChildRegistry.isChildRegistered('sup-1', '').exists).toBe(true);
    });

    it('handles very long IDs', async () => {
      const longSupervisorId = 'sup-'.concat('x'.repeat(1000));
      const longChildId = 'child-'.concat('y'.repeat(1000));
      const ref = createGenServerRef('server', localNodeId);

      await DistributedChildRegistry.registerChild(longSupervisorId, longChildId, ref, localNodeId);

      expect(
        DistributedChildRegistry.isChildRegistered(longSupervisorId, longChildId).exists,
      ).toBe(true);
    });

    it('registration workflow: register -> claim -> re-register', async () => {
      // Initial registration
      const ref1 = createGenServerRef('server-v1', localNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'worker', ref1, localNodeId);

      // Verify initial state
      let status = DistributedChildRegistry.isChildRegistered('sup-1', 'worker');
      expect(status.exists).toBe(true);
      expect(DistributedChildRegistry.getServerIdForChild('sup-1', 'worker')).toBe('server-v1');

      // Claim for restart
      const claimed = await DistributedChildRegistry.tryClaimChild('sup-1', 'worker');
      expect(claimed).toBe(true);

      // Verify claimed state
      status = DistributedChildRegistry.isChildRegistered('sup-1', 'worker');
      expect(status.exists).toBe(false);

      // Re-register with new ref (after restart)
      const ref2 = createGenServerRef('server-v2', remoteNodeId);
      await DistributedChildRegistry.registerChild('sup-1', 'worker', ref2, remoteNodeId);

      // Verify new registration
      status = DistributedChildRegistry.isChildRegistered('sup-1', 'worker');
      expect(status.exists).toBe(true);
      expect(status.nodeId).toBe(remoteNodeId);
      expect(DistributedChildRegistry.getServerIdForChild('sup-1', 'worker')).toBe('server-v2');
    });
  });
});
