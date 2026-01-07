import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PendingSpawns } from '../../../src/distribution/remote/pending-spawns.js';
import { generateSpawnId } from '../../../src/distribution/serialization.js';
import { NodeId } from '../../../src/distribution/node-id.js';
import {
  RemoteSpawnTimeoutError,
  NodeNotReachableError,
} from '../../../src/distribution/types.js';

describe('PendingSpawns', () => {
  let pendingSpawns: PendingSpawns;
  let testNodeId: ReturnType<typeof NodeId.parse>;

  beforeEach(() => {
    pendingSpawns = new PendingSpawns();
    testNodeId = NodeId.parse('test@127.0.0.1:4369');
  });

  afterEach(async () => {
    // Clear any remaining pending spawns and wait for rejections to be handled
    if (pendingSpawns.size > 0) {
      pendingSpawns.clear();
      // Give time for rejections to propagate
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });

  describe('register', () => {
    it('registers a pending spawn and returns spawnId and promise', async () => {
      const spawnId = generateSpawnId();
      const { spawnId: returnedSpawnId, promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      expect(returnedSpawnId).toBe(spawnId);
      expect(promise).toBeInstanceOf(Promise);
      expect(pendingSpawns.size).toBe(1);

      // Clean up
      pendingSpawns.resolve(spawnId, { serverId: 'server1', nodeId: testNodeId });
      await promise;
    });

    it('tracks multiple pending spawns', async () => {
      const spawnId1 = generateSpawnId();
      const spawnId2 = generateSpawnId();
      const spawnId3 = generateSpawnId();

      const { promise: p1 } = pendingSpawns.register({
        spawnId: spawnId1,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: p2 } = pendingSpawns.register({
        spawnId: spawnId2,
        behaviorName: 'cache',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: p3 } = pendingSpawns.register({
        spawnId: spawnId3,
        behaviorName: 'worker',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      expect(pendingSpawns.size).toBe(3);

      // Clean up
      pendingSpawns.resolve(spawnId1, { serverId: 'server1', nodeId: testNodeId });
      pendingSpawns.resolve(spawnId2, { serverId: 'server2', nodeId: testNodeId });
      pendingSpawns.resolve(spawnId3, { serverId: 'server3', nodeId: testNodeId });
      await Promise.all([p1, p2, p3]);
    });
  });

  describe('resolve', () => {
    it('resolves a pending spawn with result', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const result = { serverId: 'spawned-server', nodeId: testNodeId };
      const resolved = pendingSpawns.resolve(spawnId, result);

      expect(resolved).toBe(true);
      expect(pendingSpawns.size).toBe(0);
      await expect(promise).resolves.toEqual(result);
    });

    it('returns false for unknown spawnId', () => {
      const unknownSpawnId = generateSpawnId();
      const resolved = pendingSpawns.resolve(unknownSpawnId, {
        serverId: 'server1',
        nodeId: testNodeId,
      });

      expect(resolved).toBe(false);
    });

    it('returns false for already resolved spawn', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const firstResult = { serverId: 'first', nodeId: testNodeId };
      const secondResult = { serverId: 'second', nodeId: testNodeId };

      pendingSpawns.resolve(spawnId, firstResult);
      const secondResolve = pendingSpawns.resolve(spawnId, secondResult);

      expect(secondResolve).toBe(false);
      await expect(promise).resolves.toEqual(firstResult);
    });

    it('result contains correct serverId and nodeId', async () => {
      const spawnId = generateSpawnId();
      const targetNode = NodeId.parse('remote@192.168.1.100:4370');
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: targetNode,
        timeoutMs: 5000,
      });

      const result = { serverId: 'remote-counter-123', nodeId: targetNode };
      pendingSpawns.resolve(spawnId, result);

      const resolved = await promise;
      expect(resolved.serverId).toBe('remote-counter-123');
      expect(resolved.nodeId).toBe(targetNode);
    });
  });

  describe('reject', () => {
    it('rejects a pending spawn with error', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const error = new Error('Test error');
      const rejected = pendingSpawns.reject(spawnId, error);

      expect(rejected).toBe(true);
      expect(pendingSpawns.size).toBe(0);
      await expect(promise).rejects.toThrow('Test error');
    });

    it('returns false for unknown spawnId', () => {
      const unknownSpawnId = generateSpawnId();
      const rejected = pendingSpawns.reject(unknownSpawnId, new Error('test'));

      expect(rejected).toBe(false);
    });

    it('returns false for already rejected spawn', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      pendingSpawns.reject(spawnId, new Error('first error'));
      const secondReject = pendingSpawns.reject(spawnId, new Error('second error'));

      expect(secondReject).toBe(false);
      await expect(promise).rejects.toThrow('first error');
    });
  });

  describe('timeout handling', () => {
    it('automatically rejects spawn after timeout', async () => {
      vi.useFakeTimers();

      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'slow-behavior',
        nodeId: testNodeId,
        timeoutMs: 100,
      });

      expect(pendingSpawns.isPending(spawnId)).toBe(true);

      // Advance time past timeout
      vi.advanceTimersByTime(150);

      await expect(promise).rejects.toThrow(RemoteSpawnTimeoutError);
      await expect(promise).rejects.toThrow(/slow-behavior/);
      expect(pendingSpawns.isPending(spawnId)).toBe(false);

      vi.useRealTimers();
    });

    it('timeout error contains correct details', async () => {
      vi.useFakeTimers();

      const spawnId = generateSpawnId();
      const targetNode = NodeId.parse('slow@192.168.1.50:4370');
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'my-behavior',
        nodeId: targetNode,
        timeoutMs: 200,
      });

      vi.advanceTimersByTime(250);

      try {
        await promise;
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteSpawnTimeoutError);
        const timeoutError = error as RemoteSpawnTimeoutError;
        expect(timeoutError.behaviorName).toBe('my-behavior');
        expect(timeoutError.nodeId).toBe(targetNode);
        expect(timeoutError.timeoutMs).toBe(200);
      }

      vi.useRealTimers();
    });

    it('does not timeout if resolved before timeout', async () => {
      vi.useFakeTimers();

      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 100,
      });

      // Resolve before timeout
      vi.advanceTimersByTime(50);
      pendingSpawns.resolve(spawnId, { serverId: 'server1', nodeId: testNodeId });

      // Advance past timeout
      vi.advanceTimersByTime(100);

      const result = await promise;
      expect(result.serverId).toBe('server1');

      vi.useRealTimers();
    });

    it('clears timeout when rejected before timeout', async () => {
      vi.useFakeTimers();

      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 100,
      });

      // Reject before timeout
      vi.advanceTimersByTime(50);
      pendingSpawns.reject(spawnId, new Error('Rejected early'));

      // Advance past timeout
      vi.advanceTimersByTime(100);

      await expect(promise).rejects.toThrow('Rejected early');

      vi.useRealTimers();
    });
  });

  describe('isPending', () => {
    it('returns true for pending spawn', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      expect(pendingSpawns.isPending(spawnId)).toBe(true);

      // Clean up
      pendingSpawns.resolve(spawnId, { serverId: 'server1', nodeId: testNodeId });
      await promise;
    });

    it('returns false for resolved spawn', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      pendingSpawns.resolve(spawnId, { serverId: 'server1', nodeId: testNodeId });
      await promise;

      expect(pendingSpawns.isPending(spawnId)).toBe(false);
    });

    it('returns false for rejected spawn', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      pendingSpawns.reject(spawnId, new Error('test'));

      await expect(promise).rejects.toThrow();
      expect(pendingSpawns.isPending(spawnId)).toBe(false);
    });

    it('returns false for unknown spawnId', () => {
      const unknownSpawnId = generateSpawnId();
      expect(pendingSpawns.isPending(unknownSpawnId)).toBe(false);
    });
  });

  describe('get', () => {
    it('returns spawn info for pending spawn', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'my-counter',
        nodeId: testNodeId,
        timeoutMs: 10000,
      });

      const info = pendingSpawns.get(spawnId);

      expect(info).toBeDefined();
      expect(info?.behaviorName).toBe('my-counter');
      expect(info?.nodeId).toBe(testNodeId);
      expect(info?.timeoutMs).toBe(10000);
      expect(info?.createdAt).toBeLessThanOrEqual(Date.now());
      expect(info?.elapsedMs).toBeGreaterThanOrEqual(0);

      // Clean up
      pendingSpawns.resolve(spawnId, { serverId: 'server1', nodeId: testNodeId });
      await promise;
    });

    it('returns undefined for unknown spawnId', () => {
      const unknownSpawnId = generateSpawnId();
      expect(pendingSpawns.get(unknownSpawnId)).toBeUndefined();
    });

    it('returns undefined for resolved spawn', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      pendingSpawns.resolve(spawnId, { serverId: 'server1', nodeId: testNodeId });
      await promise;

      expect(pendingSpawns.get(spawnId)).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('returns initial stats', () => {
      const stats = pendingSpawns.getStats();

      expect(stats.pendingCount).toBe(0);
      expect(stats.totalInitiated).toBe(0);
      expect(stats.totalResolved).toBe(0);
      expect(stats.totalRejected).toBe(0);
      expect(stats.totalTimedOut).toBe(0);
    });

    it('tracks initiated spawns', async () => {
      const spawnId1 = generateSpawnId();
      const spawnId2 = generateSpawnId();

      const { promise: p1 } = pendingSpawns.register({
        spawnId: spawnId1,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: p2 } = pendingSpawns.register({
        spawnId: spawnId2,
        behaviorName: 'cache',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const stats = pendingSpawns.getStats();
      expect(stats.totalInitiated).toBe(2);
      expect(stats.pendingCount).toBe(2);

      // Clean up
      pendingSpawns.resolve(spawnId1, { serverId: 'server1', nodeId: testNodeId });
      pendingSpawns.resolve(spawnId2, { serverId: 'server2', nodeId: testNodeId });
      await p1;
      await p2;
    });

    it('tracks resolved spawns', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      pendingSpawns.resolve(spawnId, { serverId: 'server1', nodeId: testNodeId });
      await promise;

      const stats = pendingSpawns.getStats();
      expect(stats.totalResolved).toBe(1);
      expect(stats.pendingCount).toBe(0);
    });

    it('tracks rejected spawns', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      pendingSpawns.reject(spawnId, new Error('test'));

      await expect(promise).rejects.toThrow('test');

      const stats = pendingSpawns.getStats();
      expect(stats.totalRejected).toBe(1);
      expect(stats.pendingCount).toBe(0);
    });

    it('tracks timed out spawns', async () => {
      vi.useFakeTimers();

      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 100,
      });

      vi.advanceTimersByTime(150);

      await expect(promise).rejects.toThrow(RemoteSpawnTimeoutError);

      const stats = pendingSpawns.getStats();
      expect(stats.totalTimedOut).toBe(1);

      vi.useRealTimers();
    });

    it('tracks multiple operations correctly', async () => {
      vi.useFakeTimers();

      const spawnIds = [
        generateSpawnId(),
        generateSpawnId(),
        generateSpawnId(),
        generateSpawnId(),
      ];

      const promises = spawnIds.map((spawnId, i) =>
        pendingSpawns.register({
          spawnId,
          behaviorName: `behavior${i}`,
          nodeId: testNodeId,
          timeoutMs: i === 3 ? 50 : 5000, // Last one will timeout
        }).promise,
      );

      // Resolve first, reject second, leave third pending, let fourth timeout
      pendingSpawns.resolve(spawnIds[0], { serverId: 'server0', nodeId: testNodeId });
      pendingSpawns.reject(spawnIds[1], new Error('rejected'));

      vi.advanceTimersByTime(100);

      // Handle all promises
      await expect(promises[0]).resolves.toBeDefined();
      await expect(promises[1]).rejects.toThrow();
      await expect(promises[3]).rejects.toThrow(RemoteSpawnTimeoutError);

      // Clean up remaining
      pendingSpawns.clear();
      await Promise.allSettled([promises[2]]);

      const stats = pendingSpawns.getStats();
      expect(stats.totalInitiated).toBe(4);
      expect(stats.totalResolved).toBe(1);
      // 1 reject + 1 clear (timeout counts separately in totalTimedOut)
      expect(stats.totalRejected).toBe(2);
      expect(stats.totalTimedOut).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('rejectAllForNode', () => {
    it('rejects all pending spawns to a specific node', async () => {
      const nodeId1 = NodeId.parse('node1@127.0.0.1:4369');
      const nodeId2 = NodeId.parse('node2@127.0.0.1:4370');

      const spawnId1 = generateSpawnId();
      const spawnId2 = generateSpawnId();
      const spawnId3 = generateSpawnId();

      const { promise: promise1 } = pendingSpawns.register({
        spawnId: spawnId1,
        behaviorName: 'behavior1',
        nodeId: nodeId1,
        timeoutMs: 5000,
      });
      const { promise: promise2 } = pendingSpawns.register({
        spawnId: spawnId2,
        behaviorName: 'behavior2',
        nodeId: nodeId1,
        timeoutMs: 5000,
      });
      const { promise: promise3 } = pendingSpawns.register({
        spawnId: spawnId3,
        behaviorName: 'behavior3',
        nodeId: nodeId2,
        timeoutMs: 5000,
      });

      const error = new NodeNotReachableError(nodeId1);
      const rejected = pendingSpawns.rejectAllForNode(nodeId1, error);

      expect(rejected).toBe(2);
      expect(pendingSpawns.size).toBe(1);

      await expect(promise1).rejects.toThrow(NodeNotReachableError);
      await expect(promise2).rejects.toThrow(NodeNotReachableError);

      // promise3 should still be pending
      expect(pendingSpawns.isPending(spawnId3)).toBe(true);

      // Clean up
      pendingSpawns.resolve(spawnId3, { serverId: 'server3', nodeId: nodeId2 });
      await promise3;
    });

    it('returns 0 when no spawns for node', () => {
      const nodeId = NodeId.parse('unknown@127.0.0.1:4369');
      const rejected = pendingSpawns.rejectAllForNode(nodeId, new Error('test'));

      expect(rejected).toBe(0);
    });

    it('does not affect already resolved spawns', async () => {
      const nodeId = NodeId.parse('node1@127.0.0.1:4369');

      const spawnId1 = generateSpawnId();
      const spawnId2 = generateSpawnId();

      const { promise: promise1 } = pendingSpawns.register({
        spawnId: spawnId1,
        behaviorName: 'behavior1',
        nodeId,
        timeoutMs: 5000,
      });
      const { promise: promise2 } = pendingSpawns.register({
        spawnId: spawnId2,
        behaviorName: 'behavior2',
        nodeId,
        timeoutMs: 5000,
      });

      // Resolve first before rejecting all
      pendingSpawns.resolve(spawnId1, { serverId: 'server1', nodeId });

      const rejected = pendingSpawns.rejectAllForNode(nodeId, new Error('node down'));

      expect(rejected).toBe(1); // Only second one should be rejected

      await expect(promise1).resolves.toBeDefined();
      await expect(promise2).rejects.toThrow('node down');
    });
  });

  describe('clear', () => {
    it('clears all pending spawns with error', async () => {
      const spawnId1 = generateSpawnId();
      const spawnId2 = generateSpawnId();

      const { promise: promise1 } = pendingSpawns.register({
        spawnId: spawnId1,
        behaviorName: 'behavior1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: promise2 } = pendingSpawns.register({
        spawnId: spawnId2,
        behaviorName: 'behavior2',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const error = new Error('Cluster shutdown');
      pendingSpawns.clear(error);

      expect(pendingSpawns.size).toBe(0);

      const results = await Promise.allSettled([promise1, promise2]);
      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('rejected');
      expect((results[0] as PromiseRejectedResult).reason.message).toBe('Cluster shutdown');
      expect((results[1] as PromiseRejectedResult).reason.message).toBe('Cluster shutdown');
    });

    it('clears all pending spawns with default error', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'counter',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      pendingSpawns.clear();

      await expect(promise).rejects.toThrow('Pending spawns cleared');
    });

    it('tracks rejected count for cleared spawns', async () => {
      const spawnId1 = generateSpawnId();
      const spawnId2 = generateSpawnId();

      const { promise: p1 } = pendingSpawns.register({
        spawnId: spawnId1,
        behaviorName: 'behavior1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: p2 } = pendingSpawns.register({
        spawnId: spawnId2,
        behaviorName: 'behavior2',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      pendingSpawns.clear();

      await Promise.allSettled([p1, p2]);

      const stats = pendingSpawns.getStats();
      expect(stats.totalRejected).toBe(2);
    });

    it('does not affect already resolved spawns in stats', async () => {
      const spawnId1 = generateSpawnId();
      const spawnId2 = generateSpawnId();

      const { promise: p1 } = pendingSpawns.register({
        spawnId: spawnId1,
        behaviorName: 'behavior1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: p2 } = pendingSpawns.register({
        spawnId: spawnId2,
        behaviorName: 'behavior2',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      // Resolve first
      pendingSpawns.resolve(spawnId1, { serverId: 'server1', nodeId: testNodeId });
      await p1;

      // Then clear
      pendingSpawns.clear();
      await Promise.allSettled([p2]);

      const stats = pendingSpawns.getStats();
      expect(stats.totalResolved).toBe(1);
      expect(stats.totalRejected).toBe(1);
    });
  });

  describe('concurrent operations', () => {
    it('handles multiple simultaneous resolves correctly', async () => {
      const spawnIds = Array.from({ length: 10 }, () => generateSpawnId());
      const promises = spawnIds.map((spawnId, i) =>
        pendingSpawns.register({
          spawnId,
          behaviorName: `behavior${i}`,
          nodeId: testNodeId,
          timeoutMs: 5000,
        }).promise,
      );

      // Resolve all concurrently
      spawnIds.forEach((spawnId, i) => {
        pendingSpawns.resolve(spawnId, { serverId: `server${i}`, nodeId: testNodeId });
      });

      const results = await Promise.all(promises);

      expect(results.map(r => r.serverId)).toEqual(
        spawnIds.map((_, i) => `server${i}`),
      );
      expect(pendingSpawns.size).toBe(0);
    });

    it('handles mixed resolve/reject operations', async () => {
      const spawnId1 = generateSpawnId();
      const spawnId2 = generateSpawnId();
      const spawnId3 = generateSpawnId();

      const { promise: promise1 } = pendingSpawns.register({
        spawnId: spawnId1,
        behaviorName: 'behavior1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: promise2 } = pendingSpawns.register({
        spawnId: spawnId2,
        behaviorName: 'behavior2',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: promise3 } = pendingSpawns.register({
        spawnId: spawnId3,
        behaviorName: 'behavior3',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      pendingSpawns.resolve(spawnId1, { serverId: 'server1', nodeId: testNodeId });
      pendingSpawns.reject(spawnId2, new Error('spawn failed'));
      pendingSpawns.resolve(spawnId3, { serverId: 'server3', nodeId: testNodeId });

      await expect(promise1).resolves.toEqual({ serverId: 'server1', nodeId: testNodeId });
      await expect(promise2).rejects.toThrow('spawn failed');
      await expect(promise3).resolves.toEqual({ serverId: 'server3', nodeId: testNodeId });

      const stats = pendingSpawns.getStats();
      expect(stats.totalResolved).toBe(2);
      expect(stats.totalRejected).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('handles empty string behavior name', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: '',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const info = pendingSpawns.get(spawnId);
      expect(info?.behaviorName).toBe('');

      pendingSpawns.resolve(spawnId, { serverId: 'server1', nodeId: testNodeId });
      await promise;
    });

    it('handles very short timeout', async () => {
      vi.useFakeTimers();

      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'quick',
        nodeId: testNodeId,
        timeoutMs: 1,
      });

      vi.advanceTimersByTime(5);

      await expect(promise).rejects.toThrow(RemoteSpawnTimeoutError);

      vi.useRealTimers();
    });

    it('handles very long timeout without memory issues', async () => {
      const spawnId = generateSpawnId();
      const { promise } = pendingSpawns.register({
        spawnId,
        behaviorName: 'long',
        nodeId: testNodeId,
        timeoutMs: 3600000, // 1 hour
      });

      // Should still work correctly
      expect(pendingSpawns.isPending(spawnId)).toBe(true);

      pendingSpawns.resolve(spawnId, { serverId: 'server1', nodeId: testNodeId });
      await promise;
    });
  });
});
