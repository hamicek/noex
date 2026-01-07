import { describe, it, expect } from 'vitest';
import {
  NodeId,
  RemoteServerNotRunningError,
  RemoteCallTimeoutError,
  NodeNotReachableError,
  ClusterNotStartedError,
  InvalidClusterConfigError,
  CLUSTER_DEFAULTS,
} from '../../src/index.js';
import type {
  NodeIdType,
  NodeStatus,
  NodeInfo,
  ClusterConfig,
  CallId,
  MonitorId,
  ClusterMessage,
  HeartbeatMessage,
  CallMessage,
  CallReplyMessage,
  CallErrorMessage,
  CastMessage,
  RegistrySyncMessage,
  NodeDownMessage,
  RemoteErrorType,
  NodeDownReason,
  ProcessDownReason,
  MonitorRequestMessage,
  MonitorAckMessage,
  DemonitorRequestMessage,
  ProcessDownMessage,
  MessageEnvelope,
  SerializedRef,
  RegistrySyncEntry,
  NodeUpHandler,
  NodeDownHandler,
  ClusterStatusHandler,
  ClusterStatus,
  MonitorRef,
} from '../../src/index.js';

describe('Distribution Types', () => {
  const testNodeId = NodeId.parse('app1@localhost:4369');

  describe('NodeStatus', () => {
    it('accepts valid status values', () => {
      const statuses: NodeStatus[] = ['connecting', 'connected', 'disconnected'];
      expect(statuses).toHaveLength(3);
    });
  });

  describe('NodeInfo', () => {
    it('can be constructed with all fields', () => {
      const info: NodeInfo = {
        id: testNodeId,
        host: 'localhost',
        port: 4369,
        status: 'connected',
        processCount: 10,
        lastHeartbeatAt: Date.now(),
        uptimeMs: 5000,
      };

      expect(info.id).toBe(testNodeId);
      expect(info.status).toBe('connected');
      expect(info.processCount).toBe(10);
    });
  });

  describe('ClusterConfig', () => {
    it('accepts minimal configuration', () => {
      const config: ClusterConfig = {
        nodeName: 'app1',
      };

      expect(config.nodeName).toBe('app1');
    });

    it('accepts full configuration', () => {
      const config: ClusterConfig = {
        nodeName: 'app1',
        host: '192.168.1.1',
        port: 5000,
        seeds: ['app2@192.168.1.2:5000'],
        clusterSecret: 'secret123',
        heartbeatIntervalMs: 3000,
        heartbeatMissThreshold: 5,
        reconnectBaseDelayMs: 500,
        reconnectMaxDelayMs: 60000,
      };

      expect(config.nodeName).toBe('app1');
      expect(config.port).toBe(5000);
      expect(config.seeds).toHaveLength(1);
      expect(config.clusterSecret).toBe('secret123');
    });
  });

  describe('SerializedRef', () => {
    it('can be constructed', () => {
      const ref: SerializedRef = {
        id: 'server-1',
        nodeId: testNodeId,
      };

      expect(ref.id).toBe('server-1');
      expect(ref.nodeId).toBe(testNodeId);
    });
  });

  describe('ClusterMessage discriminated union', () => {
    it('handles HeartbeatMessage', () => {
      const msg: ClusterMessage = {
        type: 'heartbeat',
        nodeInfo: {
          id: testNodeId,
          host: 'localhost',
          port: 4369,
          status: 'connected',
          processCount: 0,
          lastHeartbeatAt: Date.now(),
          uptimeMs: 0,
        },
        knownNodes: [],
      };

      expect(msg.type).toBe('heartbeat');
      if (msg.type === 'heartbeat') {
        expect(msg.nodeInfo.id).toBe(testNodeId);
      }
    });

    it('handles CallMessage', () => {
      const msg: ClusterMessage = {
        type: 'call',
        callId: 'abc123-0000000000000000' as CallId,
        ref: { id: 'server', nodeId: testNodeId },
        msg: { action: 'get' },
        timeoutMs: 5000,
        sentAt: Date.now(),
      };

      expect(msg.type).toBe('call');
      if (msg.type === 'call') {
        expect(msg.callId).toBeDefined();
        expect(msg.timeoutMs).toBe(5000);
      }
    });

    it('handles CallReplyMessage', () => {
      const msg: ClusterMessage = {
        type: 'call_reply',
        callId: 'abc123-0000000000000000' as CallId,
        result: { count: 42 },
      };

      expect(msg.type).toBe('call_reply');
      if (msg.type === 'call_reply') {
        expect(msg.result).toEqual({ count: 42 });
      }
    });

    it('handles CallErrorMessage', () => {
      const msg: ClusterMessage = {
        type: 'call_error',
        callId: 'abc123-0000000000000000' as CallId,
        errorType: 'server_not_running',
        message: 'Server is not running',
      };

      expect(msg.type).toBe('call_error');
      if (msg.type === 'call_error') {
        expect(msg.errorType).toBe('server_not_running');
      }
    });

    it('handles CastMessage', () => {
      const msg: ClusterMessage = {
        type: 'cast',
        ref: { id: 'worker', nodeId: testNodeId },
        msg: { data: [1, 2, 3] },
      };

      expect(msg.type).toBe('cast');
      if (msg.type === 'cast') {
        expect(msg.ref.id).toBe('worker');
      }
    });

    it('handles RegistrySyncMessage', () => {
      const msg: ClusterMessage = {
        type: 'registry_sync',
        entries: [
          {
            name: 'main-server',
            ref: { id: 'server-1', nodeId: testNodeId },
            registeredAt: Date.now(),
            priority: 1,
          },
        ],
        fullSync: true,
      };

      expect(msg.type).toBe('registry_sync');
      if (msg.type === 'registry_sync') {
        expect(msg.entries).toHaveLength(1);
        expect(msg.fullSync).toBe(true);
      }
    });

    it('handles NodeDownMessage', () => {
      const msg: ClusterMessage = {
        type: 'node_down',
        nodeId: testNodeId,
        detectedAt: Date.now(),
        reason: 'heartbeat_timeout',
      };

      expect(msg.type).toBe('node_down');
      if (msg.type === 'node_down') {
        expect(msg.reason).toBe('heartbeat_timeout');
      }
    });

    it('enables exhaustive pattern matching', () => {
      const handleMessage = (msg: ClusterMessage): string => {
        switch (msg.type) {
          case 'heartbeat':
            return `heartbeat from ${msg.nodeInfo.id}`;
          case 'call':
            return `call ${msg.callId}`;
          case 'call_reply':
            return `reply for ${msg.callId}`;
          case 'call_error':
            return `error for ${msg.callId}: ${msg.message}`;
          case 'cast':
            return `cast to ${msg.ref.id}`;
          case 'registry_sync':
            return `sync ${msg.entries.length} entries`;
          case 'node_down':
            return `node down: ${msg.nodeId}`;
        }
      };

      const msg: ClusterMessage = { type: 'cast', ref: { id: 'x', nodeId: testNodeId }, msg: {} };
      expect(handleMessage(msg)).toBe('cast to x');
    });
  });

  describe('RemoteErrorType', () => {
    it('accepts valid error types', () => {
      const types: RemoteErrorType[] = [
        'server_not_running',
        'call_timeout',
        'serialization_error',
        'unknown_error',
      ];
      expect(types).toHaveLength(4);
    });
  });

  describe('NodeDownReason', () => {
    it('accepts valid reasons', () => {
      const reasons: NodeDownReason[] = [
        'heartbeat_timeout',
        'connection_closed',
        'connection_refused',
        'graceful_shutdown',
      ];
      expect(reasons).toHaveLength(4);
    });
  });

  describe('ClusterStatus', () => {
    it('accepts valid statuses', () => {
      const statuses: ClusterStatus[] = ['starting', 'running', 'stopping', 'stopped'];
      expect(statuses).toHaveLength(4);
    });
  });

  describe('Event Handler Types', () => {
    it('NodeUpHandler can be implemented', () => {
      const handler: NodeUpHandler = (node: NodeInfo) => {
        console.log(`Node up: ${node.id}`);
      };

      expect(typeof handler).toBe('function');
    });

    it('NodeDownHandler can be implemented', () => {
      const handler: NodeDownHandler = (nodeId: NodeIdType, reason: NodeDownReason) => {
        console.log(`Node down: ${nodeId}, reason: ${reason}`);
      };

      expect(typeof handler).toBe('function');
    });

    it('ClusterStatusHandler can be implemented', () => {
      const handler: ClusterStatusHandler = (status: ClusterStatus) => {
        console.log(`Cluster status: ${status}`);
      };

      expect(typeof handler).toBe('function');
    });
  });

  describe('MessageEnvelope', () => {
    it('can be constructed with all fields', () => {
      const envelope: MessageEnvelope = {
        version: 1,
        from: testNodeId,
        timestamp: Date.now(),
        signature: 'abc123',
        payload: {
          type: 'heartbeat',
          nodeInfo: {
            id: testNodeId,
            host: 'localhost',
            port: 4369,
            status: 'connected',
            processCount: 0,
            lastHeartbeatAt: Date.now(),
            uptimeMs: 0,
          },
          knownNodes: [],
        },
      };

      expect(envelope.version).toBe(1);
      expect(envelope.from).toBe(testNodeId);
      expect(envelope.signature).toBe('abc123');
    });
  });

  describe('RegistrySyncEntry', () => {
    it('can be constructed', () => {
      const entry: RegistrySyncEntry = {
        name: 'counter',
        ref: { id: 'counter-1', nodeId: testNodeId },
        registeredAt: Date.now(),
        priority: 1,
      };

      expect(entry.name).toBe('counter');
      expect(entry.priority).toBe(1);
    });
  });
});

describe('Process Monitoring Types', () => {
  const testNodeId = NodeId.parse('app1@localhost:4369');
  const testMonitorId = 'mabc123-0123456789abcdef' as MonitorId;

  describe('ProcessDownReason', () => {
    it('accepts normal termination', () => {
      const reason: ProcessDownReason = { type: 'normal' };
      expect(reason.type).toBe('normal');
    });

    it('accepts shutdown termination', () => {
      const reason: ProcessDownReason = { type: 'shutdown' };
      expect(reason.type).toBe('shutdown');
    });

    it('accepts error with message', () => {
      const reason: ProcessDownReason = { type: 'error', message: 'Something went wrong' };
      expect(reason.type).toBe('error');
      if (reason.type === 'error') {
        expect(reason.message).toBe('Something went wrong');
      }
    });

    it('accepts noproc (process did not exist)', () => {
      const reason: ProcessDownReason = { type: 'noproc' };
      expect(reason.type).toBe('noproc');
    });

    it('accepts noconnection (node down)', () => {
      const reason: ProcessDownReason = { type: 'noconnection' };
      expect(reason.type).toBe('noconnection');
    });
  });

  describe('MonitorRef', () => {
    it('can be constructed with monitorId and monitoredRef', () => {
      const ref: MonitorRef = {
        monitorId: testMonitorId,
        monitoredRef: { id: 'remote-server', nodeId: testNodeId },
      };

      expect(ref.monitorId).toBe(testMonitorId);
      expect(ref.monitoredRef.id).toBe('remote-server');
      expect(ref.monitoredRef.nodeId).toBe(testNodeId);
    });
  });

  describe('MonitorRequestMessage', () => {
    it('can be constructed', () => {
      const msg: MonitorRequestMessage = {
        type: 'monitor_request',
        monitorId: testMonitorId,
        monitoringRef: { id: 'local-server', nodeId: testNodeId },
        monitoredRef: { id: 'remote-server', nodeId: testNodeId },
      };

      expect(msg.type).toBe('monitor_request');
      expect(msg.monitorId).toBe(testMonitorId);
    });
  });

  describe('MonitorAckMessage', () => {
    it('can be constructed for success', () => {
      const msg: MonitorAckMessage = {
        type: 'monitor_ack',
        monitorId: testMonitorId,
        success: true,
      };

      expect(msg.type).toBe('monitor_ack');
      expect(msg.success).toBe(true);
      expect(msg.reason).toBeUndefined();
    });

    it('can be constructed for failure', () => {
      const msg: MonitorAckMessage = {
        type: 'monitor_ack',
        monitorId: testMonitorId,
        success: false,
        reason: 'Process not found',
      };

      expect(msg.success).toBe(false);
      expect(msg.reason).toBe('Process not found');
    });
  });

  describe('DemonitorRequestMessage', () => {
    it('can be constructed', () => {
      const msg: DemonitorRequestMessage = {
        type: 'demonitor_request',
        monitorId: testMonitorId,
      };

      expect(msg.type).toBe('demonitor_request');
      expect(msg.monitorId).toBe(testMonitorId);
    });
  });

  describe('ProcessDownMessage', () => {
    it('can be constructed with normal reason', () => {
      const msg: ProcessDownMessage = {
        type: 'process_down',
        monitorId: testMonitorId,
        monitoredRef: { id: 'server-1', nodeId: testNodeId },
        reason: { type: 'normal' },
      };

      expect(msg.type).toBe('process_down');
      expect(msg.reason.type).toBe('normal');
    });

    it('can be constructed with error reason', () => {
      const msg: ProcessDownMessage = {
        type: 'process_down',
        monitorId: testMonitorId,
        monitoredRef: { id: 'server-1', nodeId: testNodeId },
        reason: { type: 'error', message: 'Crash' },
      };

      expect(msg.type).toBe('process_down');
      if (msg.reason.type === 'error') {
        expect(msg.reason.message).toBe('Crash');
      }
    });
  });

  describe('ClusterMessage includes monitor messages', () => {
    it('handles MonitorRequestMessage in union', () => {
      const msg: ClusterMessage = {
        type: 'monitor_request',
        monitorId: testMonitorId,
        monitoringRef: { id: 'local', nodeId: testNodeId },
        monitoredRef: { id: 'remote', nodeId: testNodeId },
      };

      expect(msg.type).toBe('monitor_request');
    });

    it('handles ProcessDownMessage in union', () => {
      const msg: ClusterMessage = {
        type: 'process_down',
        monitorId: testMonitorId,
        monitoredRef: { id: 'server', nodeId: testNodeId },
        reason: { type: 'noconnection' },
      };

      expect(msg.type).toBe('process_down');
    });
  });
});

describe('Distribution Error Classes', () => {
  const testNodeId = NodeId.parse('app1@localhost:4369');

  describe('RemoteServerNotRunningError', () => {
    it('creates error with correct properties', () => {
      const error = new RemoteServerNotRunningError('my-server', testNodeId);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RemoteServerNotRunningError);
      expect(error.name).toBe('RemoteServerNotRunningError');
      expect(error.serverId).toBe('my-server');
      expect(error.nodeId).toBe(testNodeId);
      expect(error.message).toBe(
        `GenServer 'my-server' is not running on node '${testNodeId}'`,
      );
    });
  });

  describe('RemoteCallTimeoutError', () => {
    it('creates error with correct properties', () => {
      const error = new RemoteCallTimeoutError('my-server', testNodeId, 5000);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RemoteCallTimeoutError);
      expect(error.name).toBe('RemoteCallTimeoutError');
      expect(error.serverId).toBe('my-server');
      expect(error.nodeId).toBe(testNodeId);
      expect(error.timeoutMs).toBe(5000);
      expect(error.message).toContain('5000ms');
    });
  });

  describe('NodeNotReachableError', () => {
    it('creates error with correct properties', () => {
      const error = new NodeNotReachableError(testNodeId);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(NodeNotReachableError);
      expect(error.name).toBe('NodeNotReachableError');
      expect(error.nodeId).toBe(testNodeId);
      expect(error.message).toBe(`Node '${testNodeId}' is not reachable`);
    });
  });

  describe('ClusterNotStartedError', () => {
    it('creates error with correct message', () => {
      const error = new ClusterNotStartedError();

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ClusterNotStartedError);
      expect(error.name).toBe('ClusterNotStartedError');
      expect(error.message).toContain('Cluster has not been started');
    });
  });

  describe('InvalidClusterConfigError', () => {
    it('creates error with correct properties', () => {
      const error = new InvalidClusterConfigError('port must be positive');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(InvalidClusterConfigError);
      expect(error.name).toBe('InvalidClusterConfigError');
      expect(error.reason).toBe('port must be positive');
      expect(error.message).toContain('port must be positive');
    });
  });
});
