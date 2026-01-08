/**
 * Tests for node-crash-simulator.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestCluster, TestClusterFactory } from './cluster-factory.js';
import {
  NodeCrashSimulator,
  createCrashSimulator,
  killRandomNodes,
  rollingRestartCluster,
  createSplitBrain,
  triggerCascadeFailure,
  type NodeCrashResult,
  type ChaosPatternResult,
} from './node-crash-simulator.js';

describe('NodeCrashSimulator', () => {
  let cluster: TestCluster | null = null;

  afterEach(async () => {
    if (cluster) {
      await cluster.stop();
      cluster = null;
    }
  }, 30000);

  describe('crashNode', () => {
    it('crashes a single node with process_exit mode', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 29000,
      });

      await cluster.waitForFullMesh(10000);

      const simulator = new NodeCrashSimulator(cluster);
      const nodeId = cluster.getNodeIds()[0]!;

      const result = await simulator.crashNode(nodeId, 'process_exit');

      expect(result.success).toBe(true);
      expect(result.nodeId).toBe(nodeId);
      expect(result.mode).toBe('process_exit');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(cluster.getNode(nodeId)?.status).toBe('crashed');
    }, 25000);

    it('crashes a node with abrupt_kill mode', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 29010,
      });

      await cluster.waitForFullMesh(10000);

      const simulator = new NodeCrashSimulator(cluster);
      const nodeId = cluster.getNodeIds()[0]!;

      const result = await simulator.crashNode(nodeId, 'abrupt_kill');

      expect(result.success).toBe(true);
      expect(result.mode).toBe('abrupt_kill');
      expect(cluster.getNode(nodeId)?.status).toBe('crashed');
    }, 25000);

    it('crashes a node with network_disconnect mode', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 29020,
      });

      await cluster.waitForFullMesh(10000);

      const simulator = new NodeCrashSimulator(cluster);
      const nodeId = cluster.getNodeIds()[0]!;

      const result = await simulator.crashNode(nodeId, 'network_disconnect');

      expect(result.success).toBe(true);
      expect(result.mode).toBe('network_disconnect');
    }, 25000);

    it('crashes a node with slow_death mode', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 29030,
      });

      await cluster.waitForFullMesh(10000);

      const simulator = new NodeCrashSimulator(cluster);
      const nodeId = cluster.getNodeIds()[0]!;

      const result = await simulator.crashNode(nodeId, 'slow_death');

      expect(result.success).toBe(true);
      expect(result.mode).toBe('slow_death');
      // Slow death should take some time due to delay
      expect(result.durationMs).toBeGreaterThanOrEqual(100);
    }, 25000);

    it('returns error for non-existent node', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 1,
        basePort: 29040,
      });

      const simulator = new NodeCrashSimulator(cluster);

      const result = await simulator.crashNode('nonexistent@127.0.0.1:9999');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('not found');
    }, 15000);

    it('returns error for already crashed node', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 29050,
      });

      await cluster.waitForFullMesh(10000);

      const simulator = new NodeCrashSimulator(cluster);
      const nodeId = cluster.getNodeIds()[0]!;

      // First crash
      await simulator.crashNode(nodeId);

      // Second crash attempt
      const result = await simulator.crashNode(nodeId);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('not running');
    }, 25000);
  });

  describe('crashMultiple', () => {
    it('crashes multiple nodes simultaneously', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 3,
        basePort: 29060,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);
      const nodeIds = cluster.getNodeIds().slice(0, 2) as string[];

      const results = await simulator.crashMultiple(nodeIds);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(1);
    }, 30000);
  });

  describe('events', () => {
    it('emits beforeCrash and afterCrash events', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 29070,
      });

      await cluster.waitForFullMesh(10000);

      const simulator = new NodeCrashSimulator(cluster);
      const nodeId = cluster.getNodeIds()[0]!;

      const beforeEvents: Array<{ nodeId: string; mode: string }> = [];
      const afterEvents: NodeCrashResult[] = [];

      simulator.on('beforeCrash', (nId, mode) => {
        beforeEvents.push({ nodeId: nId, mode });
      });

      simulator.on('afterCrash', (result) => {
        afterEvents.push(result);
      });

      await simulator.crashNode(nodeId, 'process_exit');

      expect(beforeEvents).toHaveLength(1);
      expect(beforeEvents[0]?.nodeId).toBe(nodeId);
      expect(afterEvents).toHaveLength(1);
      expect(afterEvents[0]?.success).toBe(true);
    }, 25000);
  });

  describe('randomKill', () => {
    it('kills a random node', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 3,
        basePort: 29080,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);

      const result = await simulator.randomKill({ count: 1 });

      expect(result.success).toBe(true);
      expect(result.pattern).toBe('random_kill');
      expect(result.nodeResults).toHaveLength(1);
      expect(cluster.getRunningNodeCount()).toBe(2);
    }, 30000);

    it('kills multiple random nodes', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 4,
        basePort: 29090,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);

      const result = await simulator.randomKill({ count: 2 });

      expect(result.success).toBe(true);
      expect(result.nodeResults).toHaveLength(2);
      expect(cluster.getRunningNodeCount()).toBe(2);
    }, 30000);

    it('respects excludeNodeIds', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 3,
        basePort: 29100,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);
      const protectedNode = cluster.getNodeIds()[0]!;

      const result = await simulator.randomKill({
        count: 2,
        excludeNodeIds: [protectedNode],
      });

      expect(result.success).toBe(true);
      expect(result.nodeResults.every((r) => r.nodeId !== protectedNode)).toBe(true);
      expect(cluster.getNode(protectedNode)?.status).toBe('running');
    }, 30000);

    it('applies delay between kills', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 3,
        basePort: 29110,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);

      const startTime = Date.now();
      const result = await simulator.randomKill({
        count: 2,
        minDelayMs: 100,
        maxDelayMs: 200,
      });
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(true);
      // Should have at least one delay of 100-200ms
      expect(elapsed).toBeGreaterThanOrEqual(100);
    }, 30000);
  });

  describe('rollingRestart', () => {
    it('restarts a single node', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 29120,
      });

      await cluster.waitForFullMesh(10000);

      const simulator = new NodeCrashSimulator(cluster);
      const targetNode = cluster.getNodeIds()[0]!;

      const result = await simulator.rollingRestart({
        nodeIds: [targetNode],
        delayBetweenMs: 500,
        waitForRejoin: true,
        rejoinTimeoutMs: 15000,
      });

      expect(result.pattern).toBe('rolling_restart');
      expect(result.nodeResults).toHaveLength(1);

      // Wait for node to be fully running
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // At minimum, verify the operation completed and node is back
      expect(cluster.getNode(targetNode)?.status).toBe('running');
    }, 60000);

    it('restarts only specified nodes', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 3,
        basePort: 29130,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);
      const targetNode = cluster.getNodeIds()[0]!;

      const result = await simulator.rollingRestart({
        nodeIds: [targetNode],
        waitForRejoin: true,
        rejoinTimeoutMs: 10000,
      });

      expect(result.nodeResults).toHaveLength(1);
      expect(result.nodeResults[0]?.nodeId).toBe(targetNode);
    }, 45000);
  });

  describe('splitBrain', () => {
    it('creates a split brain scenario', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 4,
        basePort: 29140,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);

      const result = await simulator.splitBrain({
        survivingPartition: 'larger',
      });

      expect(result.pattern).toBe('split_brain');
      expect(result.nodeResults.length).toBeGreaterThan(0);
      // Half the nodes should be crashed
      expect(cluster.getRunningNodeCount()).toBe(2);
    }, 30000);

    it('respects explicit partition definitions', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 4,
        basePort: 29150,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);
      const nodeIds = cluster.getNodeIds() as string[];

      const result = await simulator.splitBrain({
        partition1: [nodeIds[0]!],
        partition2: nodeIds.slice(1),
        survivingPartition: 'partition2',
      });

      expect(result.success).toBe(true);
      // Partition 1 (1 node) should be killed
      expect(cluster.getNode(nodeIds[0]!)?.status).toBe('crashed');
      expect(cluster.getRunningNodeCount()).toBe(3);
    }, 30000);

    it('heals partition after duration', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 3,
        basePort: 29160,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);

      const result = await simulator.splitBrain({
        splitDurationMs: 1000,
        survivingPartition: 'larger',
      });

      expect(result.success).toBe(true);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(1000);

      // Wait for nodes to rejoin
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await cluster.waitForFullMesh(10000);

      expect(cluster.getRunningNodeCount()).toBe(3);
    }, 45000);
  });

  describe('cascadeFailure', () => {
    it('triggers cascade failure starting from random node', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 4,
        basePort: 29170,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);

      const result = await simulator.cascadeFailure({
        spreadProbability: 1.0,
        cascadeDelayMs: 200,
      });

      expect(result.pattern).toBe('cascade_failure');
      expect(result.nodeResults.length).toBeGreaterThanOrEqual(1);
      // At least one node should survive (default maxCrashes = all but one)
      expect(cluster.getRunningNodeCount()).toBeGreaterThanOrEqual(1);
    }, 30000);

    it('respects maxCrashes limit', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 5,
        basePort: 29180,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);

      const result = await simulator.cascadeFailure({
        maxCrashes: 2,
        spreadProbability: 1.0,
      });

      expect(result.nodeResults.length).toBeLessThanOrEqual(2);
      expect(cluster.getRunningNodeCount()).toBeGreaterThanOrEqual(3);
    }, 30000);

    it('starts from specified node', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 3,
        basePort: 29190,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);
      const startNode = cluster.getNodeIds()[0]!;

      const result = await simulator.cascadeFailure({
        startNodeId: startNode,
        maxCrashes: 1,
      });

      expect(result.nodeResults).toHaveLength(1);
      expect(result.nodeResults[0]?.nodeId).toBe(startNode);
    }, 30000);
  });

  describe('getClusterStats', () => {
    it('returns accurate cluster statistics', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 3,
        basePort: 29200,
      });

      await cluster.waitForFullMesh(15000);

      const simulator = new NodeCrashSimulator(cluster);

      let stats = simulator.getClusterStats();
      expect(stats.totalNodes).toBe(3);
      expect(stats.runningNodes).toBe(3);
      expect(stats.crashedNodes).toBe(0);
      expect(stats.isFullMesh).toBe(true);

      // Crash one node
      await simulator.crashNode(cluster.getNodeIds()[0]!);

      stats = simulator.getClusterStats();
      expect(stats.runningNodes).toBe(2);
      expect(stats.crashedNodes).toBe(1);
    }, 30000);
  });
});

describe('Convenience functions', () => {
  let cluster: TestCluster | null = null;

  afterEach(async () => {
    if (cluster) {
      await cluster.stop();
      cluster = null;
    }
  }, 30000);

  describe('createCrashSimulator', () => {
    it('creates a simulator instance', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 29210,
      });

      const simulator = createCrashSimulator(cluster);
      expect(simulator).toBeInstanceOf(NodeCrashSimulator);
    }, 15000);
  });

  describe('killRandomNodes', () => {
    it('kills random nodes', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 3,
        basePort: 29220,
      });

      await cluster.waitForFullMesh(15000);

      const result = await killRandomNodes(cluster, 1);

      expect(result.success).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(2);
    }, 30000);
  });

  describe('createSplitBrain', () => {
    it('creates split brain without auto-heal', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 4,
        basePort: 29230,
      });

      await cluster.waitForFullMesh(15000);

      const result = await createSplitBrain(cluster, 0);

      expect(result.pattern).toBe('split_brain');
      expect(cluster.getRunningNodeCount()).toBe(2);
    }, 30000);
  });

  describe('triggerCascadeFailure', () => {
    it('triggers cascade from start node', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 3,
        basePort: 29240,
      });

      await cluster.waitForFullMesh(15000);

      const startNode = cluster.getNodeIds()[0]!;
      const result = await triggerCascadeFailure(cluster, startNode);

      expect(result.pattern).toBe('cascade_failure');
      expect(result.nodeResults[0]?.nodeId).toBe(startNode);
    }, 30000);
  });
});
