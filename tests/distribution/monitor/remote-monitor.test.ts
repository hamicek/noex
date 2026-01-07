import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RemoteMonitor,
  RemoteMonitorTimeoutError,
  _resetRemoteMonitorState,
} from '../../../src/distribution/monitor/remote-monitor.js';
import { MonitorRegistry } from '../../../src/distribution/monitor/monitor-registry.js';
import { generateMonitorId } from '../../../src/distribution/serialization.js';
import { NodeId } from '../../../src/distribution/node-id.js';
import { GenServer } from '../../../src/core/gen-server.js';
import type {
  MonitorAckMessage,
  ProcessDownMessage,
  SerializedRef,
  ClusterMessage,
} from '../../../src/distribution/types.js';
import type { GenServerRef, LifecycleEvent } from '../../../src/core/types.js';

// Mock Cluster module
vi.mock('../../../src/distribution/cluster/cluster.js', () => {
  const sentMessages: Array<{ nodeId: string; message: ClusterMessage }> = [];
  let isConnected = true;
  let mockLocalNodeId = 'local@127.0.0.1:4369';
  const nodeDownHandlers: Array<(nodeId: string, reason: string) => void> = [];

  return {
    Cluster: {
      _getTransport: () => ({
        isConnectedTo: (nodeId: string) => isConnected,
        send: async (nodeId: string, message: ClusterMessage) => {
          sentMessages.push({ nodeId, message });
        },
      }),
      getLocalNodeId: () => mockLocalNodeId,
      onNodeDown: (handler: (nodeId: string, reason: string) => void) => {
        nodeDownHandlers.push(handler);
        return () => {
          const index = nodeDownHandlers.indexOf(handler);
          if (index !== -1) {
            nodeDownHandlers.splice(index, 1);
          }
        };
      },
      // Test helpers
      _getSentMessages: () => sentMessages,
      _clearSentMessages: () => {
        sentMessages.length = 0;
      },
      _setConnected: (connected: boolean) => {
        isConnected = connected;
      },
      _setLocalNodeId: (nodeId: string) => {
        mockLocalNodeId = nodeId;
      },
      _simulateNodeDown: (nodeId: string, reason: string) => {
        for (const handler of nodeDownHandlers) {
          handler(nodeId, reason);
        }
      },
      _clearNodeDownHandlers: () => {
        nodeDownHandlers.length = 0;
      },
    },
  };
});

// Import the mocked Cluster
import { Cluster } from '../../../src/distribution/cluster/cluster.js';

// Type assertion for test helpers
const ClusterTest = Cluster as typeof Cluster & {
  _getSentMessages: () => Array<{ nodeId: string; message: ClusterMessage }>;
  _clearSentMessages: () => void;
  _setConnected: (connected: boolean) => void;
  _setLocalNodeId: (nodeId: string) => void;
  _simulateNodeDown: (nodeId: string, reason: string) => void;
  _clearNodeDownHandlers: () => void;
};

describe('RemoteMonitor', () => {
  let localNodeId: ReturnType<typeof NodeId.parse>;
  let remoteNodeId: ReturnType<typeof NodeId.parse>;

  const createMockRef = (
    id: string,
    nodeId?: string,
  ): GenServerRef => ({
    id,
    nodeId,
  } as GenServerRef);

  const createSerializedRef = (
    id: string,
    nodeId: string,
  ): SerializedRef => ({
    id,
    nodeId: nodeId as ReturnType<typeof NodeId.parse>,
  });

  beforeEach(() => {
    localNodeId = NodeId.parse('local@127.0.0.1:4369');
    remoteNodeId = NodeId.parse('remote@127.0.0.1:4370');

    ClusterTest._setLocalNodeId(localNodeId as string);
    ClusterTest._setConnected(true);
    ClusterTest._clearSentMessages();
    ClusterTest._clearNodeDownHandlers();
  });

  afterEach(() => {
    _resetRemoteMonitorState();
    GenServer._clearLifecycleHandlers();
  });

  // ==========================================================================
  // monitor() Tests
  // ==========================================================================

  describe('monitor', () => {
    it('sends monitor request to remote node', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      // Start monitor in background (won't resolve without ack)
      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 100,
      });

      // Give it time to send the request
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].nodeId).toBe(remoteNodeId);
      expect(sentMessages[0].message.type).toBe('monitor_request');

      // Cleanup - let it timeout
      await expect(monitorPromise).rejects.toThrow(RemoteMonitorTimeoutError);
    });

    it('resolves with MonitorRef on successful ack', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      // Wait for request to be sent
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Get the monitor ID from sent request
      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      // Simulate successful ack
      const ack: MonitorAckMessage = {
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      };
      RemoteMonitor._handleMonitorAck(ack);

      const result = await monitorPromise;
      expect(result.monitorId).toBe(request.monitorId);
      expect(result.monitoredRef.id).toBe('remoteServer');
    });

    it('rejects when ack has success=false', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      const ack: MonitorAckMessage = {
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: false,
        reason: 'Test failure',
      };
      RemoteMonitor._handleMonitorAck(ack);

      await expect(monitorPromise).rejects.toThrow('Test failure');
    });

    it('times out when no ack received', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      await expect(
        RemoteMonitor.monitor(monitoringRef, monitoredRef, { timeout: 50 }),
      ).rejects.toThrow(RemoteMonitorTimeoutError);
    });

    it('throws when target node is not connected', async () => {
      ClusterTest._setConnected(false);

      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      await expect(
        RemoteMonitor.monitor(monitoringRef, monitoredRef),
      ).rejects.toThrow('not reachable');
    });

    it('throws when monitored ref has no nodeId', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer'); // No nodeId

      await expect(
        RemoteMonitor.monitor(monitoringRef, monitoredRef),
      ).rejects.toThrow('must have a nodeId');
    });

    it('registers outgoing monitor in registry on success', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      const ack: MonitorAckMessage = {
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      };
      RemoteMonitor._handleMonitorAck(ack);

      await monitorPromise;

      const registry = RemoteMonitor._getRegistry();
      expect(registry.outgoingCount).toBe(1);
      expect(registry.getOutgoing(request.monitorId as ReturnType<typeof generateMonitorId>)).toBeDefined();
    });
  });

  // ==========================================================================
  // demonitor() Tests
  // ==========================================================================

  describe('demonitor', () => {
    it('sends demonitor request to remote node', async () => {
      // First establish a monitor
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      RemoteMonitor._handleMonitorAck({
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      });

      const monitorRef = await monitorPromise;
      ClusterTest._clearSentMessages();

      // Now demonitor
      await RemoteMonitor.demonitor(monitorRef);

      const demonitorMessages = ClusterTest._getSentMessages();
      expect(demonitorMessages).toHaveLength(1);
      expect(demonitorMessages[0].message.type).toBe('demonitor_request');
    });

    it('removes monitor from registry', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      RemoteMonitor._handleMonitorAck({
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      });

      const monitorRef = await monitorPromise;

      const registry = RemoteMonitor._getRegistry();
      expect(registry.outgoingCount).toBe(1);

      await RemoteMonitor.demonitor(monitorRef);

      expect(registry.outgoingCount).toBe(0);
    });

    it('handles demonitor for non-existent monitor gracefully', async () => {
      const monitorRef = {
        monitorId: generateMonitorId(),
        monitoredRef: createSerializedRef('remoteServer', remoteNodeId as string),
      };

      // Should not throw
      await expect(RemoteMonitor.demonitor(monitorRef)).resolves.not.toThrow();
    });

    it('updates statistics on demonitor', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      RemoteMonitor._handleMonitorAck({
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      });

      const monitorRef = await monitorPromise;
      await RemoteMonitor.demonitor(monitorRef);

      const stats = RemoteMonitor.getStats();
      expect(stats.totalDemonitored).toBe(1);
    });
  });

  // ==========================================================================
  // _handleProcessDown Tests
  // ==========================================================================

  describe('_handleProcessDown', () => {
    it('emits process_down lifecycle event', async () => {
      // Setup: establish a monitor
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      RemoteMonitor._handleMonitorAck({
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      });

      await monitorPromise;

      // Setup lifecycle event listener
      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        receivedEvents.push(event);
      });

      // Mock _getRefById to return a ref
      const originalGetRefById = GenServer._getRefById;
      vi.spyOn(GenServer, '_getRefById').mockImplementation((id: string) => {
        if (id === 'localServer') {
          return monitoringRef;
        }
        return originalGetRefById(id);
      });

      // Simulate process_down message
      const processDown: ProcessDownMessage = {
        type: 'process_down',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        monitoredRef: createSerializedRef('remoteServer', remoteNodeId as string),
        reason: { type: 'normal' },
      };

      RemoteMonitor._handleProcessDown(processDown);

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].type).toBe('process_down');
      if (receivedEvents[0].type === 'process_down') {
        expect(receivedEvents[0].reason.type).toBe('normal');
        expect(receivedEvents[0].monitoredRef.id).toBe('remoteServer');
      }

      vi.restoreAllMocks();
    });

    it('removes monitor from registry on process_down', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      RemoteMonitor._handleMonitorAck({
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      });

      await monitorPromise;

      const registry = RemoteMonitor._getRegistry();
      expect(registry.outgoingCount).toBe(1);

      const processDown: ProcessDownMessage = {
        type: 'process_down',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        monitoredRef: createSerializedRef('remoteServer', remoteNodeId as string),
        reason: { type: 'error', message: 'Test error' },
      };

      RemoteMonitor._handleProcessDown(processDown);

      expect(registry.outgoingCount).toBe(0);
    });

    it('handles process_down for unknown monitor gracefully', () => {
      const processDown: ProcessDownMessage = {
        type: 'process_down',
        monitorId: generateMonitorId(),
        monitoredRef: createSerializedRef('remoteServer', remoteNodeId as string),
        reason: { type: 'normal' },
      };

      // Should not throw
      expect(() => RemoteMonitor._handleProcessDown(processDown)).not.toThrow();
    });

    it('updates statistics on process_down', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      RemoteMonitor._handleMonitorAck({
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      });

      await monitorPromise;

      RemoteMonitor._handleProcessDown({
        type: 'process_down',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        monitoredRef: createSerializedRef('remoteServer', remoteNodeId as string),
        reason: { type: 'shutdown' },
      });

      const stats = RemoteMonitor.getStats();
      expect(stats.totalProcessDownReceived).toBe(1);
    });
  });

  // ==========================================================================
  // Node Down Handling Tests
  // ==========================================================================

  describe('node down handling', () => {
    it('rejects pending monitors when node goes down', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 5000,
      });

      // Wait for request to be sent
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate node down
      ClusterTest._simulateNodeDown(remoteNodeId as string, 'connection_closed');

      await expect(monitorPromise).rejects.toThrow('not reachable');
    });

    it('emits noconnection process_down for active monitors when node goes down', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      RemoteMonitor._handleMonitorAck({
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      });

      await monitorPromise;

      // Setup lifecycle event listener
      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        receivedEvents.push(event);
      });

      // Mock _getRefById
      vi.spyOn(GenServer, '_getRefById').mockImplementation((id: string) => {
        if (id === 'localServer') {
          return monitoringRef;
        }
        return undefined;
      });

      // Simulate node down
      ClusterTest._simulateNodeDown(remoteNodeId as string, 'heartbeat_timeout');

      expect(receivedEvents).toHaveLength(1);
      if (receivedEvents[0].type === 'process_down') {
        expect(receivedEvents[0].reason.type).toBe('noconnection');
      }

      vi.restoreAllMocks();
    });

    it('removes all monitors to downed node from registry', async () => {
      // Setup multiple monitors to the same remote node
      const monitorPromises: Promise<unknown>[] = [];

      for (let i = 0; i < 3; i++) {
        const monitoringRef = createMockRef(`localServer${i}`, localNodeId as string);
        const monitoredRef = createMockRef(`remoteServer${i}`, remoteNodeId as string);

        const promise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
          timeout: 1000,
        });
        monitorPromises.push(promise);
      }

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Acknowledge all monitors
      const sentMessages = ClusterTest._getSentMessages();
      for (const msg of sentMessages) {
        if (msg.message.type === 'monitor_request') {
          const request = msg.message as { monitorId: string };
          RemoteMonitor._handleMonitorAck({
            type: 'monitor_ack',
            monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
            success: true,
          });
        }
      }

      await Promise.all(monitorPromises);

      const registry = RemoteMonitor._getRegistry();
      expect(registry.outgoingCount).toBe(3);

      // Simulate node down
      ClusterTest._simulateNodeDown(remoteNodeId as string, 'connection_closed');

      expect(registry.outgoingCount).toBe(0);
    });
  });

  // ==========================================================================
  // Statistics Tests
  // ==========================================================================

  describe('getStats', () => {
    it('returns initial stats', () => {
      const stats = RemoteMonitor.getStats();

      expect(stats.initialized).toBe(false);
      expect(stats.pendingCount).toBe(0);
      expect(stats.activeOutgoingCount).toBe(0);
      expect(stats.totalInitiated).toBe(0);
      expect(stats.totalEstablished).toBe(0);
      expect(stats.totalTimedOut).toBe(0);
      expect(stats.totalDemonitored).toBe(0);
      expect(stats.totalProcessDownReceived).toBe(0);
    });

    it('tracks initiated monitors', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 50,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const stats = RemoteMonitor.getStats();
      expect(stats.initialized).toBe(true);
      expect(stats.totalInitiated).toBe(1);
      expect(stats.pendingCount).toBe(1);

      // Let it timeout
      await expect(monitorPromise).rejects.toThrow();
    });

    it('tracks established monitors', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      RemoteMonitor._handleMonitorAck({
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      });

      await monitorPromise;

      const stats = RemoteMonitor.getStats();
      expect(stats.totalEstablished).toBe(1);
      expect(stats.activeOutgoingCount).toBe(1);
      expect(stats.pendingCount).toBe(0);
    });

    it('tracks timed out monitors', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      await expect(
        RemoteMonitor.monitor(monitoringRef, monitoredRef, { timeout: 50 }),
      ).rejects.toThrow();

      const stats = RemoteMonitor.getStats();
      expect(stats.totalTimedOut).toBe(1);
    });
  });

  // ==========================================================================
  // Complex Scenarios
  // ==========================================================================

  describe('complex scenarios', () => {
    it('handles multiple monitors to different servers', async () => {
      const remoteNode2 = NodeId.parse('remote2@127.0.0.1:4371');
      const monitorPromises: Promise<unknown>[] = [];

      // Monitor on first remote node
      for (let i = 0; i < 2; i++) {
        const monitoringRef = createMockRef(`localServer${i}`, localNodeId as string);
        const monitoredRef = createMockRef(`remoteServer${i}`, remoteNodeId as string);
        monitorPromises.push(
          RemoteMonitor.monitor(monitoringRef, monitoredRef, { timeout: 1000 }),
        );
      }

      // Monitor on second remote node
      for (let i = 0; i < 2; i++) {
        const monitoringRef = createMockRef(`localServer${i + 2}`, localNodeId as string);
        const monitoredRef = createMockRef(`remoteServer${i + 2}`, remoteNode2 as string);
        monitorPromises.push(
          RemoteMonitor.monitor(monitoringRef, monitoredRef, { timeout: 1000 }),
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Acknowledge all monitors
      const sentMessages = ClusterTest._getSentMessages();
      for (const msg of sentMessages) {
        if (msg.message.type === 'monitor_request') {
          const request = msg.message as { monitorId: string };
          RemoteMonitor._handleMonitorAck({
            type: 'monitor_ack',
            monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
            success: true,
          });
        }
      }

      await Promise.all(monitorPromises);

      const registry = RemoteMonitor._getRegistry();
      expect(registry.outgoingCount).toBe(4);

      const stats = RemoteMonitor.getStats();
      expect(stats.totalEstablished).toBe(4);
    });

    it('handles rapid monitor/demonitor cycles', async () => {
      for (let cycle = 0; cycle < 5; cycle++) {
        const monitoringRef = createMockRef('localServer', localNodeId as string);
        const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

        const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
          timeout: 1000,
        });

        await new Promise((resolve) => setTimeout(resolve, 10));

        const sentMessages = ClusterTest._getSentMessages();
        const request = sentMessages[sentMessages.length - 1].message as { monitorId: string };

        RemoteMonitor._handleMonitorAck({
          type: 'monitor_ack',
          monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
          success: true,
        });

        const monitorRef = await monitorPromise;
        await RemoteMonitor.demonitor(monitorRef);
      }

      const stats = RemoteMonitor.getStats();
      expect(stats.totalEstablished).toBe(5);
      expect(stats.totalDemonitored).toBe(5);

      const registry = RemoteMonitor._getRegistry();
      expect(registry.outgoingCount).toBe(0);
    });
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('error handling', () => {
    it('handles duplicate acks gracefully', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      const ack: MonitorAckMessage = {
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      };

      // First ack
      RemoteMonitor._handleMonitorAck(ack);
      await monitorPromise;

      // Duplicate ack - should not throw
      expect(() => RemoteMonitor._handleMonitorAck(ack)).not.toThrow();
    });

    it('handles ack for unknown monitor gracefully', () => {
      const ack: MonitorAckMessage = {
        type: 'monitor_ack',
        monitorId: generateMonitorId(),
        success: true,
      };

      // Should not throw
      expect(() => RemoteMonitor._handleMonitorAck(ack)).not.toThrow();
    });
  });

  // ==========================================================================
  // Cleanup Tests
  // ==========================================================================

  describe('cleanup', () => {
    it('clears all state on _clear()', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as { monitorId: string };

      RemoteMonitor._handleMonitorAck({
        type: 'monitor_ack',
        monitorId: request.monitorId as ReturnType<typeof generateMonitorId>,
        success: true,
      });

      await monitorPromise;

      const registry = RemoteMonitor._getRegistry();
      expect(registry.outgoingCount).toBe(1);

      RemoteMonitor._clear();

      expect(registry.outgoingCount).toBe(0);
    });

    it('rejects pending monitors on _clear()', async () => {
      const monitoringRef = createMockRef('localServer', localNodeId as string);
      const monitoredRef = createMockRef('remoteServer', remoteNodeId as string);

      const monitorPromise = RemoteMonitor.monitor(monitoringRef, monitoredRef, {
        timeout: 5000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      RemoteMonitor._clear();

      await expect(monitorPromise).rejects.toThrow('Cluster has not been started');
    });
  });
});
