import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PendingCalls } from '../../../src/distribution/remote/pending-calls.js';
import { generateCallId } from '../../../src/distribution/serialization.js';
import { NodeId } from '../../../src/distribution/node-id.js';
import {
  RemoteCallTimeoutError,
  RemoteServerNotRunningError,
  NodeNotReachableError,
} from '../../../src/distribution/types.js';

describe('PendingCalls', () => {
  let pendingCalls: PendingCalls;
  let testNodeId: ReturnType<typeof NodeId.parse>;

  beforeEach(() => {
    pendingCalls = new PendingCalls();
    testNodeId = NodeId.parse('test@127.0.0.1:4369');
  });

  afterEach(async () => {
    // Clear any remaining pending calls and wait for rejections to be handled
    if (pendingCalls.size > 0) {
      // Collect all pending promises before clearing
      const pendingPromises: Promise<unknown>[] = [];
      // We need to manually track promises or just clear and ignore
      pendingCalls.clear();
      // Give time for rejections to propagate
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });

  describe('register', () => {
    it('registers a pending call and returns callId and promise', async () => {
      const callId = generateCallId();
      const { callId: returnedCallId, promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      expect(returnedCallId).toBe(callId);
      expect(promise).toBeInstanceOf(Promise);
      expect(pendingCalls.size).toBe(1);

      // Clean up
      pendingCalls.resolve(callId, 'result');
      await promise;
    });

    it('tracks multiple pending calls', async () => {
      const callId1 = generateCallId();
      const callId2 = generateCallId();
      const callId3 = generateCallId();

      const { promise: p1 } = pendingCalls.register({
        callId: callId1,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: p2 } = pendingCalls.register({
        callId: callId2,
        serverId: 'server2',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: p3 } = pendingCalls.register({
        callId: callId3,
        serverId: 'server3',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      expect(pendingCalls.size).toBe(3);

      // Clean up
      pendingCalls.resolve(callId1, 'result');
      pendingCalls.resolve(callId2, 'result');
      pendingCalls.resolve(callId3, 'result');
      await Promise.all([p1, p2, p3]);
    });
  });

  describe('resolve', () => {
    it('resolves a pending call with result', async () => {
      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const result = { data: 'test' };
      const resolved = pendingCalls.resolve(callId, result);

      expect(resolved).toBe(true);
      expect(pendingCalls.size).toBe(0);
      await expect(promise).resolves.toEqual(result);
    });

    it('returns false for unknown callId', () => {
      const unknownCallId = generateCallId();
      const resolved = pendingCalls.resolve(unknownCallId, 'result');

      expect(resolved).toBe(false);
    });

    it('returns false for already resolved call', async () => {
      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      pendingCalls.resolve(callId, 'first');
      const secondResolve = pendingCalls.resolve(callId, 'second');

      expect(secondResolve).toBe(false);
      await expect(promise).resolves.toBe('first');
    });
  });

  describe('reject', () => {
    it('rejects a pending call with error', async () => {
      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const error = new Error('Test error');
      const rejected = pendingCalls.reject(callId, error);

      expect(rejected).toBe(true);
      expect(pendingCalls.size).toBe(0);
      await expect(promise).rejects.toThrow('Test error');
    });

    it('returns false for unknown callId', () => {
      const unknownCallId = generateCallId();
      const rejected = pendingCalls.reject(unknownCallId, new Error('test'));

      expect(rejected).toBe(false);
    });
  });

  describe('rejectServerNotRunning', () => {
    it('rejects with RemoteServerNotRunningError', async () => {
      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'myserver',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      pendingCalls.rejectServerNotRunning(callId);

      await expect(promise).rejects.toThrow(RemoteServerNotRunningError);
      await expect(promise).rejects.toThrow(/myserver/);
    });
  });

  describe('timeout handling', () => {
    it('automatically rejects call after timeout', async () => {
      vi.useFakeTimers();

      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 100,
      });

      expect(pendingCalls.isPending(callId)).toBe(true);

      // Advance time past timeout
      vi.advanceTimersByTime(150);

      await expect(promise).rejects.toThrow(RemoteCallTimeoutError);
      expect(pendingCalls.isPending(callId)).toBe(false);

      vi.useRealTimers();
    });

    it('does not timeout if resolved before timeout', async () => {
      vi.useFakeTimers();

      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 100,
      });

      // Resolve before timeout
      vi.advanceTimersByTime(50);
      pendingCalls.resolve(callId, 'success');

      // Advance past timeout
      vi.advanceTimersByTime(100);

      await expect(promise).resolves.toBe('success');

      vi.useRealTimers();
    });
  });

  describe('isPending', () => {
    it('returns true for pending call', async () => {
      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      expect(pendingCalls.isPending(callId)).toBe(true);

      // Clean up
      pendingCalls.resolve(callId, 'result');
      await promise;
    });

    it('returns false for resolved call', async () => {
      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      pendingCalls.resolve(callId, 'result');
      await promise;

      expect(pendingCalls.isPending(callId)).toBe(false);
    });

    it('returns false for unknown callId', () => {
      const unknownCallId = generateCallId();
      expect(pendingCalls.isPending(unknownCallId)).toBe(false);
    });
  });

  describe('get', () => {
    it('returns call info for pending call', async () => {
      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const info = pendingCalls.get(callId);

      expect(info).toBeDefined();
      expect(info?.serverId).toBe('server1');
      expect(info?.nodeId).toBe(testNodeId);
      expect(info?.timeoutMs).toBe(5000);
      expect(info?.createdAt).toBeLessThanOrEqual(Date.now());
      expect(info?.elapsedMs).toBeGreaterThanOrEqual(0);

      // Clean up
      pendingCalls.resolve(callId, 'result');
      await promise;
    });

    it('returns undefined for unknown callId', () => {
      const unknownCallId = generateCallId();
      expect(pendingCalls.get(unknownCallId)).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('returns initial stats', () => {
      const stats = pendingCalls.getStats();

      expect(stats.pendingCount).toBe(0);
      expect(stats.totalInitiated).toBe(0);
      expect(stats.totalResolved).toBe(0);
      expect(stats.totalRejected).toBe(0);
      expect(stats.totalTimedOut).toBe(0);
    });

    it('tracks initiated calls', async () => {
      const callId1 = generateCallId();
      const callId2 = generateCallId();

      const { promise: p1 } = pendingCalls.register({
        callId: callId1,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: p2 } = pendingCalls.register({
        callId: callId2,
        serverId: 'server2',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const stats = pendingCalls.getStats();
      expect(stats.totalInitiated).toBe(2);
      expect(stats.pendingCount).toBe(2);

      // Clean up to avoid unhandled rejections
      pendingCalls.resolve(callId1, 'result');
      pendingCalls.resolve(callId2, 'result');
      await p1;
      await p2;
    });

    it('tracks resolved calls', async () => {
      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      pendingCalls.resolve(callId, 'result');
      await promise;

      const stats = pendingCalls.getStats();
      expect(stats.totalResolved).toBe(1);
      expect(stats.pendingCount).toBe(0);
    });

    it('tracks rejected calls', async () => {
      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      pendingCalls.reject(callId, new Error('test'));

      // Catch the expected rejection
      await expect(promise).rejects.toThrow('test');

      const stats = pendingCalls.getStats();
      expect(stats.totalRejected).toBe(1);
      expect(stats.pendingCount).toBe(0);
    });

    it('tracks timed out calls', async () => {
      vi.useFakeTimers();

      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 100,
      });

      vi.advanceTimersByTime(150);

      await expect(promise).rejects.toThrow(RemoteCallTimeoutError);

      const stats = pendingCalls.getStats();
      expect(stats.totalTimedOut).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('rejectAllForNode', () => {
    it('rejects all pending calls to a specific node', async () => {
      const nodeId1 = NodeId.parse('node1@127.0.0.1:4369');
      const nodeId2 = NodeId.parse('node2@127.0.0.1:4370');

      const callId1 = generateCallId();
      const callId2 = generateCallId();
      const callId3 = generateCallId();

      const { promise: promise1 } = pendingCalls.register({
        callId: callId1,
        serverId: 'server1',
        nodeId: nodeId1,
        timeoutMs: 5000,
      });
      const { promise: promise2 } = pendingCalls.register({
        callId: callId2,
        serverId: 'server2',
        nodeId: nodeId1,
        timeoutMs: 5000,
      });
      const { promise: promise3 } = pendingCalls.register({
        callId: callId3,
        serverId: 'server3',
        nodeId: nodeId2,
        timeoutMs: 5000,
      });

      const error = new NodeNotReachableError(nodeId1);
      const rejected = pendingCalls.rejectAllForNode(nodeId1, error);

      expect(rejected).toBe(2);
      expect(pendingCalls.size).toBe(1);

      await expect(promise1).rejects.toThrow(NodeNotReachableError);
      await expect(promise2).rejects.toThrow(NodeNotReachableError);

      // promise3 should still be pending
      expect(pendingCalls.isPending(callId3)).toBe(true);

      // Clean up
      pendingCalls.resolve(callId3, 'result');
      await promise3;
    });

    it('returns 0 when no calls for node', () => {
      const nodeId = NodeId.parse('unknown@127.0.0.1:4369');
      const rejected = pendingCalls.rejectAllForNode(nodeId, new Error('test'));

      expect(rejected).toBe(0);
    });
  });

  describe('clear', () => {
    it('clears all pending calls with error', async () => {
      const callId1 = generateCallId();
      const callId2 = generateCallId();

      const { promise: promise1 } = pendingCalls.register({
        callId: callId1,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: promise2 } = pendingCalls.register({
        callId: callId2,
        serverId: 'server2',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      const error = new Error('Cluster shutdown');
      pendingCalls.clear(error);

      expect(pendingCalls.size).toBe(0);

      // Use Promise.allSettled to handle all rejections
      const results = await Promise.allSettled([promise1, promise2]);
      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('rejected');
      expect((results[0] as PromiseRejectedResult).reason.message).toBe('Cluster shutdown');
      expect((results[1] as PromiseRejectedResult).reason.message).toBe('Cluster shutdown');
    });

    it('clears all pending calls with default error', async () => {
      const callId = generateCallId();
      const { promise } = pendingCalls.register({
        callId,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      pendingCalls.clear();

      await expect(promise).rejects.toThrow('Pending calls cleared');
    });

    it('tracks rejected count for cleared calls', async () => {
      const callId1 = generateCallId();
      const callId2 = generateCallId();

      const { promise: p1 } = pendingCalls.register({
        callId: callId1,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: p2 } = pendingCalls.register({
        callId: callId2,
        serverId: 'server2',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      pendingCalls.clear();

      // Await to handle rejections
      await Promise.allSettled([p1, p2]);

      const stats = pendingCalls.getStats();
      expect(stats.totalRejected).toBe(2);
    });
  });

  describe('concurrent operations', () => {
    it('handles multiple simultaneous resolves correctly', async () => {
      const callIds = Array.from({ length: 10 }, () => generateCallId());
      const promises = callIds.map((callId, i) =>
        pendingCalls.register({
          callId,
          serverId: `server${i}`,
          nodeId: testNodeId,
          timeoutMs: 5000,
        }).promise,
      );

      // Resolve all concurrently
      callIds.forEach((callId, i) => {
        pendingCalls.resolve(callId, `result${i}`);
      });

      const results = await Promise.all(promises);

      expect(results).toEqual(callIds.map((_, i) => `result${i}`));
      expect(pendingCalls.size).toBe(0);
    });

    it('handles mixed resolve/reject operations', async () => {
      const callId1 = generateCallId();
      const callId2 = generateCallId();
      const callId3 = generateCallId();

      const { promise: promise1 } = pendingCalls.register({
        callId: callId1,
        serverId: 'server1',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: promise2 } = pendingCalls.register({
        callId: callId2,
        serverId: 'server2',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });
      const { promise: promise3 } = pendingCalls.register({
        callId: callId3,
        serverId: 'server3',
        nodeId: testNodeId,
        timeoutMs: 5000,
      });

      pendingCalls.resolve(callId1, 'success');
      pendingCalls.reject(callId2, new Error('failed'));
      pendingCalls.resolve(callId3, 'another success');

      await expect(promise1).resolves.toBe('success');
      await expect(promise2).rejects.toThrow('failed');
      await expect(promise3).resolves.toBe('another success');

      const stats = pendingCalls.getStats();
      expect(stats.totalResolved).toBe(2);
      expect(stats.totalRejected).toBe(1);
    });
  });
});
