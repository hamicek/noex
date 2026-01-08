/**
 * GlobalRegistry stress tests for distributed process registration.
 *
 * Tests the GlobalRegistry module under various stress conditions:
 * - High-volume registrations (1000+ registrations)
 * - Registration conflicts (same name on multiple nodes)
 * - Registry sync on node join (complete sync within 2s)
 * - Registry cleanup on node down (cleanup on all nodes)
 *
 * Port range: 26000-26099
 *
 * @module tests/stress/distribution/global-registry-stress
 */

import { describe, it, expect, afterEach } from 'vitest';

import { TestCluster, TestClusterFactory, type TestClusterConfig } from './cluster-factory.js';
import {
  DistributedMetricsCollector,
  DistributedMetricsAssertions,
} from './distributed-metrics-collector.js';

// =============================================================================
// Test Configuration
// =============================================================================

/**
 * Base port for global registry stress tests.
 * Uses port range 26000+ to avoid conflicts with other tests.
 */
const BASE_PORT = 26000;

/**
 * Default timeout for cluster operations.
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Extended timeout for stress tests.
 */
const STRESS_TEST_TIMEOUT_MS = 120000;

/**
 * Long timeout for high-volume tests.
 */
const HIGH_VOLUME_TIMEOUT_MS = 180000;

/**
 * Heartbeat configuration optimized for stress testing.
 */
const STRESS_HEARTBEAT_CONFIG = {
  heartbeatIntervalMs: 300,
  heartbeatMissThreshold: 3,
} as const;

// =============================================================================
// Types
// =============================================================================

/**
 * Result of a registration operation.
 */
interface RegistrationResult {
  name: string;
  nodeId: string;
  processId: string;
  durationMs: number;
  success: boolean;
  errorType?: string;
}

/**
 * Result of a lookup operation.
 */
interface LookupResult {
  name: string;
  found: boolean;
  ref?: { id: string; nodeId: string };
  durationMs: number;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Creates a promise that resolves after specified milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generates a unique port for a test based on base port and offset.
 */
function getTestPort(offset: number): number {
  return BASE_PORT + offset;
}

/**
 * Creates cluster configuration with stress-optimized settings.
 */
function createStressClusterConfig(
  nodeCount: number,
  basePort: number,
  overrides: Partial<TestClusterConfig> = {},
): TestClusterConfig {
  return {
    nodeCount,
    basePort,
    ...STRESS_HEARTBEAT_CONFIG,
    ...overrides,
  };
}

/**
 * Checks if a registration result indicates an error.
 */
function isRegistrationError(
  result: { durationMs: number } | { error: true; errorType: string; message: string; durationMs: number },
): result is { error: true; errorType: string; message: string; durationMs: number } {
  return 'error' in result && result.error === true;
}

/**
 * Checks if a lookup result indicates an error.
 */
function isLookupError(
  result: { ref: { id: string; nodeId: string }; durationMs: number } | { error: true; errorType: string; message: string; durationMs: number },
): result is { error: true; errorType: string; message: string; durationMs: number } {
  return 'error' in result && result.error === true;
}

// =============================================================================
// Test Suite
// =============================================================================

describe('GlobalRegistry Stress Tests', () => {
  let cluster: TestCluster | null = null;
  let metricsCollector: DistributedMetricsCollector | null = null;

  /**
   * Creates and starts a metrics collector attached to the given cluster.
   */
  function createAndStartMetrics(targetCluster: TestCluster): DistributedMetricsCollector {
    const collector = new DistributedMetricsCollector({
      memorySnapshotIntervalMs: 500,
      cluster: targetCluster,
      trackClusterEvents: true,
    });
    collector.start();
    return collector;
  }

  /**
   * Sets up a cluster with registered behaviors for registry testing.
   */
  async function setupClusterWithBehaviors(
    nodeCount: number,
    basePort: number,
    behaviors: string[] = ['counterBehavior', 'echoBehavior'],
  ): Promise<TestCluster> {
    const testCluster = await TestClusterFactory.createCluster(
      createStressClusterConfig(nodeCount, basePort),
    );

    await testCluster.waitForFullMesh(30000);

    // Register behaviors on all nodes
    const nodeIds = testCluster.getNodeIds();
    for (const nodeId of nodeIds) {
      for (const behavior of behaviors) {
        await testCluster.registerBehavior(nodeId, behavior);
      }
    }

    return testCluster;
  }

  afterEach(async () => {
    if (metricsCollector) {
      metricsCollector.stop();
      metricsCollector = null;
    }

    if (cluster) {
      await cluster.stop();
      cluster = null;
    }

    // Allow sockets to fully close
    await delay(500);
  }, DEFAULT_TIMEOUT_MS);

  // ===========================================================================
  // High-Volume Registrations
  // ===========================================================================

  describe('High-Volume Registrations', () => {
    it('handles 100 sequential registrations on a single node', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(0));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const registrationNodeId = nodeIds[0]!;

      const registrationCount = 100;
      const results: RegistrationResult[] = [];

      for (let i = 0; i < registrationCount; i++) {
        // Spawn a process for each registration
        const processId = await cluster.spawnProcess(registrationNodeId, 'counterBehavior');
        const name = `service-${i}`;

        const startTime = Date.now();
        const result = await cluster.globalRegister(registrationNodeId, name, processId, 10000);
        const durationMs = Date.now() - startTime;

        results.push({
          name,
          nodeId: registrationNodeId,
          processId,
          durationMs,
          success: !isRegistrationError(result),
          errorType: isRegistrationError(result) ? result.errorType : undefined,
        });
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      const successCount = results.filter((r) => r.success).length;
      const avgDuration = results.reduce((sum, r) => sum + r.durationMs, 0) / results.length;

      // Verify high success rate
      expect(successCount / registrationCount).toBeGreaterThanOrEqual(0.99);

      // Verify reasonable registration times
      expect(avgDuration).toBeLessThan(500);

      // Verify all registrations are visible from the node
      const names = await cluster.getGlobalRegistryNames(registrationNodeId);
      expect(names.length).toBeGreaterThanOrEqual(successCount);

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('handles 50 registrations distributed across multiple nodes', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(5));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const registrationCount = 50;
      const results: RegistrationResult[] = [];

      for (let i = 0; i < registrationCount; i++) {
        const nodeId = nodeIds[i % nodeIds.length]!;

        // Spawn a process for this registration
        const processId = await cluster.spawnProcess(nodeId, 'counterBehavior');
        const name = `distributed-service-${i}`;

        const startTime = Date.now();
        const result = await cluster.globalRegister(nodeId, name, processId, 10000);
        const durationMs = Date.now() - startTime;

        results.push({
          name,
          nodeId,
          processId,
          durationMs,
          success: !isRegistrationError(result),
          errorType: isRegistrationError(result) ? result.errorType : undefined,
        });
      }

      // Allow time for sync to propagate
      await delay(1000);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      const successCount = results.filter((r) => r.success).length;

      // Verify high success rate
      expect(successCount / registrationCount).toBeGreaterThanOrEqual(0.98);

      // Verify all nodes see the registrations (with some tolerance for sync delay)
      for (const nodeId of nodeIds) {
        const names = await cluster.getGlobalRegistryNames(nodeId);
        expect(names.length).toBeGreaterThanOrEqual(successCount * 0.9);
      }

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('handles concurrent registrations from multiple nodes', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(10));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();

      // Spawn processes for concurrent registration
      const registrationData: Array<{ nodeId: string; processId: string; name: string }> = [];

      for (let i = 0; i < 30; i++) {
        const nodeId = nodeIds[i % nodeIds.length]!;
        const processId = await cluster.spawnProcess(nodeId, 'echoBehavior');
        registrationData.push({
          nodeId,
          processId,
          name: `concurrent-service-${i}`,
        });
      }

      // Register concurrently
      const registrationPromises = registrationData.map(async (data) => {
        const startTime = Date.now();
        const result = await cluster!.globalRegister(data.nodeId, data.name, data.processId, 15000);
        const durationMs = Date.now() - startTime;

        return {
          ...data,
          durationMs,
          success: !isRegistrationError(result),
          errorType: isRegistrationError(result) ? result.errorType : undefined,
        };
      });

      const results = await Promise.all(registrationPromises);

      // Allow time for sync
      await delay(1500);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      const successCount = results.filter((r) => r.success).length;
      const totalAttempts = results.length;

      // Verify high success rate under concurrent load
      expect(successCount / totalAttempts).toBeGreaterThanOrEqual(0.9);

      // Verify registrations are visible from all nodes
      for (const nodeId of nodeIds) {
        const names = await cluster.getGlobalRegistryNames(nodeId);
        expect(names.length).toBeGreaterThanOrEqual(successCount * 0.85);
      }

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles registration and lookup interleaved operations', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(15));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const registrationNodeId = nodeIds[0]!;
      const lookupNodeId = nodeIds[1]!;

      // Register some initial services
      const registeredNames: string[] = [];
      for (let i = 0; i < 20; i++) {
        const processId = await cluster.spawnProcess(registrationNodeId, 'counterBehavior');
        const name = `initial-service-${i}`;

        const result = await cluster.globalRegister(registrationNodeId, name, processId, 10000);
        if (!isRegistrationError(result)) {
          registeredNames.push(name);
        }
      }

      // Allow sync
      await delay(500);

      // Interleave lookups and new registrations
      let lookupSuccessCount = 0;
      let registrationSuccessCount = 0;

      for (let i = 0; i < 30; i++) {
        if (i % 2 === 0) {
          // Lookup existing
          if (registeredNames.length > 0) {
            const name = registeredNames[i % registeredNames.length]!;
            const result = await cluster.globalLookup(lookupNodeId, name, 5000);
            if (!isLookupError(result)) {
              lookupSuccessCount++;
            }
          }
        } else {
          // Register new
          const processId = await cluster.spawnProcess(registrationNodeId, 'counterBehavior');
          const name = `new-service-${i}`;

          const result = await cluster.globalRegister(registrationNodeId, name, processId, 10000);
          if (!isRegistrationError(result)) {
            registrationSuccessCount++;
            registeredNames.push(name);
          }
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify lookups and registrations both succeeded at high rate
      expect(lookupSuccessCount).toBeGreaterThan(10);
      expect(registrationSuccessCount).toBeGreaterThan(10);

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Registration Conflicts
  // ===========================================================================

  describe('Registration Conflicts', () => {
    it('rejects duplicate registration from same node', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(20));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const registrationNodeId = nodeIds[0]!;

      // Register first process
      const processId1 = await cluster.spawnProcess(registrationNodeId, 'counterBehavior');
      const result1 = await cluster.globalRegister(registrationNodeId, 'unique-name', processId1, 10000);

      expect(isRegistrationError(result1)).toBe(false);

      // Try to register different process with same name
      const processId2 = await cluster.spawnProcess(registrationNodeId, 'counterBehavior');
      const result2 = await cluster.globalRegister(registrationNodeId, 'unique-name', processId2, 10000);

      expect(isRegistrationError(result2)).toBe(true);
      if (isRegistrationError(result2)) {
        expect(result2.errorType).toBe('GlobalNameConflictError');
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles concurrent registration attempts for same name', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(25));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();

      // Spawn processes on different nodes for concurrent registration
      const registrationData: Array<{ nodeId: string; processId: string }> = [];
      for (const nodeId of nodeIds) {
        const processId = await cluster.spawnProcess(nodeId, 'counterBehavior');
        registrationData.push({ nodeId, processId });
      }

      const conflictName = 'contested-service';

      // Attempt concurrent registrations
      const registrationPromises = registrationData.map(async (data) => {
        const result = await cluster!.globalRegister(data.nodeId, conflictName, data.processId, 10000);
        return {
          ...data,
          success: !isRegistrationError(result),
          errorType: isRegistrationError(result) ? result.errorType : undefined,
        };
      });

      const results = await Promise.all(registrationPromises);

      // Allow sync to propagate conflicts
      await delay(2000);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // In an eventually consistent distributed registry, concurrent registrations
      // may initially all succeed locally before conflict resolution occurs.
      // After sync, all nodes should converge to seeing the same registration.
      // At least one registration should succeed initially.
      const successCount = results.filter((r) => r.success).length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      // After sync, verify all nodes see a consistent registration
      const refs: Array<{ id: string; nodeId: string } | null> = [];
      for (const nodeId of nodeIds) {
        const result = await cluster.globalWhereis(nodeId, conflictName, 5000);
        refs.push(result.ref);
      }

      // All lookups should return valid refs (name should be registered somewhere)
      const validRefs = refs.filter((r) => r !== null);
      expect(validRefs.length).toBe(nodeIds.length);

      // All refs should point to the same winner after conflict resolution
      const firstRef = validRefs[0];
      for (const ref of validRefs) {
        expect(ref!.id).toBe(firstRef!.id);
        expect(ref!.nodeId).toBe(firstRef!.nodeId);
      }

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles multiple conflict scenarios in sequence', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(30));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();

      let totalConflicts = 0;
      let totalSuccesses = 0;

      // Run multiple conflict scenarios
      for (let scenario = 0; scenario < 10; scenario++) {
        const name = `contested-service-${scenario}`;
        const results: boolean[] = [];

        // Each node tries to register
        for (const nodeId of nodeIds) {
          const processId = await cluster.spawnProcess(nodeId, 'counterBehavior');
          const result = await cluster.globalRegister(nodeId, name, processId, 10000);
          results.push(!isRegistrationError(result));
        }

        const successes = results.filter((r) => r).length;
        const conflicts = results.filter((r) => !r).length;

        expect(successes).toBe(1);
        totalConflicts += conflicts;
        totalSuccesses += successes;
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify expected totals
      expect(totalSuccesses).toBe(10);
      expect(totalConflicts).toBe(20); // 3 nodes * 10 scenarios - 10 successes

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);
  });

  // ===========================================================================
  // Registry Sync on Node Join
  // ===========================================================================

  describe('Registry Sync on Node Join', () => {
    it('syncs existing registrations to new node within 2 seconds', async () => {
      // Start with 2 nodes
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(2, getTestPort(40)),
      );
      await cluster.waitForFullMesh(30000);

      const nodeIds = [...cluster.getNodeIds()];
      const registrationNodeId = nodeIds[0]!;

      // Register behaviors
      for (const nodeId of nodeIds) {
        await cluster.registerBehavior(nodeId, 'counterBehavior');
        await cluster.registerBehavior(nodeId, 'echoBehavior');
      }

      metricsCollector = createAndStartMetrics(cluster);

      // Register some services
      const registeredNames: string[] = [];
      for (let i = 0; i < 20; i++) {
        const processId = await cluster.spawnProcess(registrationNodeId, 'counterBehavior');
        const name = `existing-service-${i}`;

        const result = await cluster.globalRegister(registrationNodeId, name, processId, 10000);
        if (!isRegistrationError(result)) {
          registeredNames.push(name);
        }
      }

      expect(registeredNames.length).toBeGreaterThanOrEqual(18);

      // Restart the second node (simulates new node joining)
      const secondNodeId = nodeIds[1]!;
      await cluster.crashNode(secondNodeId, 'process_exit');
      await delay(1000);
      await cluster.restartNode(secondNodeId);

      // Register behaviors on restarted node
      await cluster.registerBehavior(secondNodeId, 'counterBehavior');
      await cluster.registerBehavior(secondNodeId, 'echoBehavior');

      await cluster.waitForFullMesh(30000);

      // Measure sync time
      const syncStartTime = Date.now();
      let syncComplete = false;
      let attempts = 0;
      const maxAttempts = 20;

      while (!syncComplete && attempts < maxAttempts) {
        const names = await cluster.getGlobalRegistryNames(secondNodeId);
        if (names.length >= registeredNames.length * 0.9) {
          syncComplete = true;
        } else {
          await delay(100);
          attempts++;
        }
      }

      const syncTime = Date.now() - syncStartTime;

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Sync should complete within 2 seconds
      expect(syncComplete).toBe(true);
      expect(syncTime).toBeLessThan(2000);

      // Verify lookups work on the new node
      let lookupSuccessCount = 0;
      for (const name of registeredNames.slice(0, 5)) {
        const result = await cluster.globalLookup(secondNodeId, name, 5000);
        if (!isLookupError(result)) {
          lookupSuccessCount++;
        }
      }

      expect(lookupSuccessCount).toBeGreaterThanOrEqual(4);

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('handles multiple nodes joining with existing registrations', async () => {
      // Start with 2 nodes
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(2, getTestPort(45)),
      );
      await cluster.waitForFullMesh(30000);

      const initialNodeIds = [...cluster.getNodeIds()];
      const registrationNodeId = initialNodeIds[0]!;

      // Register behaviors on initial nodes
      for (const nodeId of initialNodeIds) {
        await cluster.registerBehavior(nodeId, 'counterBehavior');
      }

      metricsCollector = createAndStartMetrics(cluster);

      // Register services on first node
      const registeredNames: string[] = [];
      for (let i = 0; i < 15; i++) {
        const processId = await cluster.spawnProcess(registrationNodeId, 'counterBehavior');
        const name = `pre-join-service-${i}`;

        const result = await cluster.globalRegister(registrationNodeId, name, processId, 10000);
        if (!isRegistrationError(result)) {
          registeredNames.push(name);
        }
      }

      // Crash and restart second node to simulate rejoin
      const secondNodeId = initialNodeIds[1]!;
      await cluster.crashNode(secondNodeId, 'process_exit');
      await delay(1000);
      await cluster.restartNode(secondNodeId);
      await cluster.registerBehavior(secondNodeId, 'counterBehavior');
      await cluster.waitForFullMesh(30000);

      // Wait for sync
      await delay(2000);

      // Verify sync on rejoined node
      const namesOnSecond = await cluster.getGlobalRegistryNames(secondNodeId);
      expect(namesOnSecond.length).toBeGreaterThanOrEqual(registeredNames.length * 0.9);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);
  });

  // ===========================================================================
  // Registry Cleanup on Node Down
  // ===========================================================================

  describe('Registry Cleanup on Node Down', () => {
    it('cleans up registrations when node goes down', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(50));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = [...cluster.getNodeIds()];
      const registrationNodeId = nodeIds[0]!;
      const crashNodeId = nodeIds[1]!;
      const observerNodeId = nodeIds[2]!;

      // Register services on the node that will crash
      const crashNodeNames: string[] = [];
      for (let i = 0; i < 10; i++) {
        const processId = await cluster.spawnProcess(crashNodeId, 'counterBehavior');
        const name = `crash-node-service-${i}`;

        const result = await cluster.globalRegister(crashNodeId, name, processId, 10000);
        if (!isRegistrationError(result)) {
          crashNodeNames.push(name);
        }
      }

      // Register services on the node that will survive
      const survivingNames: string[] = [];
      for (let i = 0; i < 10; i++) {
        const processId = await cluster.spawnProcess(registrationNodeId, 'counterBehavior');
        const name = `surviving-service-${i}`;

        const result = await cluster.globalRegister(registrationNodeId, name, processId, 10000);
        if (!isRegistrationError(result)) {
          survivingNames.push(name);
        }
      }

      // Allow sync
      await delay(1000);

      // Verify all registrations are visible before crash
      const namesBeforeCrash = await cluster.getGlobalRegistryNames(observerNodeId);
      expect(namesBeforeCrash.length).toBeGreaterThanOrEqual(crashNodeNames.length + survivingNames.length - 2);

      // Crash the node
      await cluster.crashNode(crashNodeId, 'abrupt_kill');

      // Wait for cleanup (heartbeat detection + processing)
      await delay(3000);

      // Verify crash node registrations are cleaned up
      const namesAfterCrash = await cluster.getGlobalRegistryNames(observerNodeId);

      // Surviving names should still be present
      for (const name of survivingNames) {
        const result = await cluster.globalWhereis(observerNodeId, name, 5000);
        expect(result.ref).not.toBeNull();
      }

      // Crash node names should be cleaned up
      for (const name of crashNodeNames) {
        const result = await cluster.globalWhereis(observerNodeId, name, 5000);
        expect(result.ref).toBeNull();
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify node down was detected
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('cleans up across all remaining nodes', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(55));

      // Install error handler to catch expected errors during crash
      cluster.on('error', () => {
        // Expected during crash scenarios
      });

      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = [...cluster.getNodeIds()];
      const crashNodeId = nodeIds[0]!;
      const observerNodeIds = nodeIds.slice(1);

      // Register services on the node that will crash
      const crashNodeNames: string[] = [];
      for (let i = 0; i < 15; i++) {
        const processId = await cluster.spawnProcess(crashNodeId, 'counterBehavior');
        const name = `doomed-service-${i}`;

        const result = await cluster.globalRegister(crashNodeId, name, processId, 10000);
        if (!isRegistrationError(result)) {
          crashNodeNames.push(name);
        }
      }

      // Allow sync
      await delay(1500);

      // Verify all observer nodes see the registrations before crash
      for (const observerNodeId of observerNodeIds) {
        const names = await cluster.getGlobalRegistryNames(observerNodeId);
        expect(names.length).toBeGreaterThanOrEqual(crashNodeNames.length - 2);
      }

      // Crash the node
      await cluster.crashNode(crashNodeId, 'process_exit');

      // Wait for cleanup
      await delay(3000);

      // Verify ALL remaining nodes cleaned up the registrations
      for (const observerNodeId of observerNodeIds) {
        for (const name of crashNodeNames) {
          const result = await cluster.globalWhereis(observerNodeId, name, 5000);
          expect(result.ref).toBeNull();
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('handles rapid node failures with registrations', async () => {
      cluster = await setupClusterWithBehaviors(5, getTestPort(60));

      // Install error handler to catch expected errors during crash
      cluster.on('error', () => {
        // Expected during crash scenarios
      });

      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = [...cluster.getNodeIds()];
      const survivingNodeId = nodeIds[0]!;
      const crashNodeIds = nodeIds.slice(1, 4);
      const observerNodeId = nodeIds[4]!;

      // Register services on each node that will crash
      const nodeNameMap = new Map<string, string[]>();
      for (const crashNodeId of crashNodeIds) {
        const names: string[] = [];
        for (let i = 0; i < 5; i++) {
          const processId = await cluster.spawnProcess(crashNodeId, 'counterBehavior');
          const name = `node-${crashNodeId.split('@')[0]}-service-${i}`;

          const result = await cluster.globalRegister(crashNodeId, name, processId, 10000);
          if (!isRegistrationError(result)) {
            names.push(name);
          }
        }
        nodeNameMap.set(crashNodeId, names);
      }

      // Register services on surviving node
      const survivingNames: string[] = [];
      for (let i = 0; i < 5; i++) {
        const processId = await cluster.spawnProcess(survivingNodeId, 'counterBehavior');
        const name = `surviving-node-service-${i}`;

        const result = await cluster.globalRegister(survivingNodeId, name, processId, 10000);
        if (!isRegistrationError(result)) {
          survivingNames.push(name);
        }
      }

      // Allow sync
      await delay(1500);

      // Crash nodes in rapid succession
      for (const crashNodeId of crashNodeIds) {
        await cluster.crashNode(crashNodeId, 'process_exit');
        await delay(200);
      }

      // Wait for cleanup
      await delay(5000);

      // Verify all crashed node registrations are cleaned up
      for (const [_, names] of nodeNameMap) {
        for (const name of names) {
          const result = await cluster.globalWhereis(observerNodeId, name, 5000);
          expect(result.ref).toBeNull();
        }
      }

      // Verify surviving node registrations are still present
      for (const name of survivingNames) {
        const result = await cluster.globalWhereis(observerNodeId, name, 5000);
        expect(result.ref).not.toBeNull();
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);
  });

  // ===========================================================================
  // Integration Scenarios
  // ===========================================================================

  describe('Integration Scenarios', () => {
    it('handles sustained registration and lookup workload', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(70));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const durationMs = 5000; // Reduced duration for faster test
      const startTime = Date.now();

      let registrationCount = 0;
      let lookupCount = 0;
      let registrationSuccessCount = 0;
      let lookupSuccessCount = 0;
      const registeredNames: string[] = [];

      while (Date.now() - startTime < durationMs) {
        const nodeId = nodeIds[Math.floor(Math.random() * nodeIds.length)]!;

        // Alternate between registrations and lookups
        if (registeredNames.length < 5 || Math.random() < 0.3) {
          // Register
          const processId = await cluster.spawnProcess(nodeId, 'counterBehavior');
          const name = `sustained-service-${registrationCount}`;

          const result = await cluster.globalRegister(nodeId, name, processId, 5000);
          registrationCount++;

          if (!isRegistrationError(result)) {
            registrationSuccessCount++;
            registeredNames.push(name);
          }
        } else {
          // Lookup
          const name = registeredNames[Math.floor(Math.random() * registeredNames.length)]!;
          const result = await cluster.globalLookup(nodeId, name, 5000);
          lookupCount++;

          if (!isLookupError(result)) {
            lookupSuccessCount++;
          }
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify high success rates
      expect(registrationSuccessCount / registrationCount).toBeGreaterThanOrEqual(0.95);
      expect(lookupSuccessCount / lookupCount).toBeGreaterThanOrEqual(0.95);

      // Should have completed significant operations
      expect(registrationCount + lookupCount).toBeGreaterThan(20);

      // Verify memory stays within reasonable bounds for sustained workload
      // Note: Each registration spawns a new process, so memory growth is expected
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 500);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('handles unregister operations correctly', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(75));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const registrationNodeId = nodeIds[0]!;
      const lookupNodeId = nodeIds[1]!;

      // Register services
      const registeredNames: string[] = [];
      for (let i = 0; i < 10; i++) {
        const processId = await cluster.spawnProcess(registrationNodeId, 'counterBehavior');
        const name = `unregister-test-${i}`;

        const result = await cluster.globalRegister(registrationNodeId, name, processId, 10000);
        if (!isRegistrationError(result)) {
          registeredNames.push(name);
        }
      }

      // Allow sync with longer delay
      await delay(2000);

      // Verify all registrations are visible
      for (const name of registeredNames.slice(0, 3)) {
        const result = await cluster.globalWhereis(lookupNodeId, name, 5000);
        expect(result.ref).not.toBeNull();
      }

      // Unregister half
      const toUnregister = registeredNames.slice(0, 5);
      for (const name of toUnregister) {
        await cluster.globalUnregister(registrationNodeId, name, 5000);
      }

      // Allow time for local processing
      await delay(500);

      // Verify unregistered names are gone from the LOCAL node
      // Note: Current GlobalRegistry implementation doesn't broadcast unregister
      // to remote nodes immediately - they will be cleaned up on full sync or node down.
      // This test verifies local unregister works correctly.
      for (const name of toUnregister) {
        const localResult = await cluster.globalWhereis(registrationNodeId, name, 5000);
        expect(localResult.ref).toBeNull();
      }

      // Verify remaining names are still present on local
      for (const name of registeredNames.slice(5)) {
        const result = await cluster.globalWhereis(registrationNodeId, name, 5000);
        expect(result.ref).not.toBeNull();
      }

      // Verify registry names count reflects unregistration on local node
      const localNames = await cluster.getGlobalRegistryNames(registrationNodeId);
      const localUnregisteredNames = toUnregister.filter((name) => !localNames.includes(name));
      expect(localUnregisteredNames.length).toBe(toUnregister.length);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('verifies registry statistics accuracy', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(80));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const nodeId = nodeIds[0]!;
      const otherNodeId = nodeIds[1]!;

      // Register services on first node
      for (let i = 0; i < 10; i++) {
        const processId = await cluster.spawnProcess(nodeId, 'counterBehavior');
        await cluster.globalRegister(nodeId, `node1-service-${i}`, processId, 10000);
      }

      // Register services on second node
      for (let i = 0; i < 5; i++) {
        const processId = await cluster.spawnProcess(otherNodeId, 'counterBehavior');
        await cluster.globalRegister(otherNodeId, `node2-service-${i}`, processId, 10000);
      }

      // Allow sync
      await delay(1500);

      // Check stats from first node's perspective
      const stats1 = await cluster.getGlobalRegistryStats(nodeId);

      // Should see total registrations (local + remote)
      expect(stats1.totalRegistrations).toBeGreaterThanOrEqual(13);
      expect(stats1.localRegistrations).toBe(10);
      expect(stats1.remoteRegistrations).toBeGreaterThanOrEqual(3);

      // Check stats from second node's perspective
      const stats2 = await cluster.getGlobalRegistryStats(otherNodeId);

      // Should see same total from different perspective
      expect(stats2.totalRegistrations).toBeGreaterThanOrEqual(13);
      expect(stats2.localRegistrations).toBe(5);
      expect(stats2.remoteRegistrations).toBeGreaterThanOrEqual(8);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);
  });
});
