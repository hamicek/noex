import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  exportToJson,
  exportToCsv,
  createExportData,
  createExportDataWithHistory,
  type ExportData,
  type MetricsHistory,
} from '../../src/observer/export-utils.js';
import type { ObserverSnapshot } from '../../src/observer/types.js';
import { GenServer, Supervisor, Registry } from '../../src/index.js';
import { Observer } from '../../src/observer/observer.js';

describe('export-utils', () => {
  const createMockSnapshot = (): ObserverSnapshot => ({
    timestamp: 1704067200000, // 2024-01-01T00:00:00.000Z
    servers: [
      {
        id: 'server-1',
        status: 'running',
        queueSize: 5,
        messageCount: 100,
        startedAt: 1704067100000,
        uptimeMs: 100000,
        stateMemoryBytes: 1024,
      },
      {
        id: 'server-2',
        status: 'running',
        queueSize: 0,
        messageCount: 50,
        startedAt: 1704067150000,
        uptimeMs: 50000,
      },
    ],
    supervisors: [
      {
        id: 'supervisor-1',
        strategy: 'one_for_one',
        childCount: 2,
        totalRestarts: 3,
        startedAt: 1704067050000,
        uptimeMs: 150000,
      },
    ],
    tree: [],
    processCount: 3,
    totalMessages: 150,
    totalRestarts: 3,
    memoryStats: {
      heapUsed: 50000000,
      heapTotal: 100000000,
      external: 1000000,
      rss: 120000000,
      timestamp: 1704067200000,
    },
  });

  const createMockMetricsHistory = (): MetricsHistory => ({
    throughput: [
      { timestamp: 1704067180000, value: 10.5 },
      { timestamp: 1704067190000, value: 12.3 },
      { timestamp: 1704067200000, value: 11.8 },
    ],
    processCount: [
      { timestamp: 1704067180000, value: 3 },
      { timestamp: 1704067190000, value: 3 },
      { timestamp: 1704067200000, value: 3 },
    ],
    restartRate: [
      { timestamp: 1704067180000, value: 0 },
      { timestamp: 1704067190000, value: 0.1 },
      { timestamp: 1704067200000, value: 0 },
    ],
    memory: [
      {
        heapUsed: 48000000,
        heapTotal: 100000000,
        external: 1000000,
        rss: 118000000,
        timestamp: 1704067180000,
      },
      {
        heapUsed: 49000000,
        heapTotal: 100000000,
        external: 1000000,
        rss: 119000000,
        timestamp: 1704067190000,
      },
      {
        heapUsed: 50000000,
        heapTotal: 100000000,
        external: 1000000,
        rss: 120000000,
        timestamp: 1704067200000,
      },
    ],
    perProcess: {
      'server-1': {
        queueSize: [
          { timestamp: 1704067180000, value: 3 },
          { timestamp: 1704067200000, value: 5 },
        ],
        messageCount: [
          { timestamp: 1704067180000, value: 90 },
          { timestamp: 1704067200000, value: 100 },
        ],
      },
    },
  });

  describe('createExportData', () => {
    it('should create export data with correct structure', () => {
      const snapshot = createMockSnapshot();
      const exportData = createExportData(snapshot);

      expect(exportData.version).toBe('1.0');
      expect(exportData.snapshot).toBe(snapshot);
      expect(exportData.exportedAt).toBeLessThanOrEqual(Date.now());
      expect(exportData.exportedAt).toBeGreaterThan(Date.now() - 1000);
      expect(exportData.metricsHistory).toBeUndefined();
    });
  });

  describe('createExportDataWithHistory', () => {
    it('should create export data with metrics history', () => {
      const snapshot = createMockSnapshot();
      const history = createMockMetricsHistory();
      const exportData = createExportDataWithHistory(snapshot, history);

      expect(exportData.version).toBe('1.0');
      expect(exportData.snapshot).toBe(snapshot);
      expect(exportData.metricsHistory).toBe(history);
      expect(exportData.exportedAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('exportToJson', () => {
    it('should produce valid JSON string', () => {
      const exportData = createExportData(createMockSnapshot());
      const json = exportToJson(exportData);

      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('should preserve all data in JSON output', () => {
      const snapshot = createMockSnapshot();
      const exportData = createExportData(snapshot);
      const json = exportToJson(exportData);
      const parsed = JSON.parse(json) as ExportData;

      expect(parsed.version).toBe('1.0');
      expect(parsed.snapshot.servers).toHaveLength(2);
      expect(parsed.snapshot.supervisors).toHaveLength(1);
      expect(parsed.snapshot.totalMessages).toBe(150);
    });

    it('should format JSON with 2-space indentation', () => {
      const exportData = createExportData(createMockSnapshot());
      const json = exportToJson(exportData);

      // Check for indentation (should have lines starting with 2 spaces)
      expect(json).toMatch(/\n  "/);
    });

    it('should include metrics history when provided', () => {
      const snapshot = createMockSnapshot();
      const history = createMockMetricsHistory();
      const exportData = createExportDataWithHistory(snapshot, history);
      const json = exportToJson(exportData);
      const parsed = JSON.parse(json) as ExportData;

      expect(parsed.metricsHistory).toBeDefined();
      expect(parsed.metricsHistory!.throughput).toHaveLength(3);
    });
  });

  describe('exportToCsv', () => {
    describe('summary CSV', () => {
      it('should produce valid CSV with headers', () => {
        const exportData = createExportData(createMockSnapshot());
        const csvs = exportToCsv(exportData);

        const lines = csvs.summary.split('\n');
        expect(lines).toHaveLength(2); // header + 1 data row

        const headers = lines[0].split(',');
        expect(headers).toContain('timestamp');
        expect(headers).toContain('processCount');
        expect(headers).toContain('totalMessages');
      });

      it('should contain correct summary data', () => {
        const exportData = createExportData(createMockSnapshot());
        const csvs = exportToCsv(exportData);

        const lines = csvs.summary.split('\n');
        const dataLine = lines[1];

        expect(dataLine).toContain('3'); // processCount
        expect(dataLine).toContain('150'); // totalMessages
        expect(dataLine).toContain('50000000'); // heapUsedBytes
      });
    });

    describe('servers CSV', () => {
      it('should produce CSV with one row per server', () => {
        const exportData = createExportData(createMockSnapshot());
        const csvs = exportToCsv(exportData);

        const lines = csvs.servers.split('\n');
        expect(lines).toHaveLength(3); // header + 2 servers
      });

      it('should include server details', () => {
        const exportData = createExportData(createMockSnapshot());
        const csvs = exportToCsv(exportData);

        expect(csvs.servers).toContain('server-1');
        expect(csvs.servers).toContain('server-2');
        expect(csvs.servers).toContain('running');
        expect(csvs.servers).toContain('100'); // messageCount
      });

      it('should handle optional stateMemoryBytes', () => {
        const exportData = createExportData(createMockSnapshot());
        const csvs = exportToCsv(exportData);

        // server-1 has stateMemoryBytes, server-2 doesn't
        expect(csvs.servers).toContain('1024');
      });
    });

    describe('supervisors CSV', () => {
      it('should produce CSV with one row per supervisor', () => {
        const exportData = createExportData(createMockSnapshot());
        const csvs = exportToCsv(exportData);

        const lines = csvs.supervisors.split('\n');
        expect(lines).toHaveLength(2); // header + 1 supervisor
      });

      it('should include supervisor details', () => {
        const exportData = createExportData(createMockSnapshot());
        const csvs = exportToCsv(exportData);

        expect(csvs.supervisors).toContain('supervisor-1');
        expect(csvs.supervisors).toContain('one_for_one');
        expect(csvs.supervisors).toContain('2'); // childCount
        expect(csvs.supervisors).toContain('3'); // totalRestarts
      });
    });

    describe('metrics history CSV', () => {
      it('should be undefined when no history provided', () => {
        const exportData = createExportData(createMockSnapshot());
        const csvs = exportToCsv(exportData);

        expect(csvs.metricsHistory).toBeUndefined();
      });

      it('should include history when provided', () => {
        const snapshot = createMockSnapshot();
        const history = createMockMetricsHistory();
        const exportData = createExportDataWithHistory(snapshot, history);
        const csvs = exportToCsv(exportData);

        expect(csvs.metricsHistory).toBeDefined();
        expect(csvs.metricsHistory).toContain('timestamp');
        expect(csvs.metricsHistory).toContain('throughput');
        expect(csvs.metricsHistory).toContain('heapUsedBytes');
      });
    });

    describe('CSV escaping', () => {
      it('should escape values with commas', () => {
        const snapshot = createMockSnapshot();
        // Modify server ID to contain comma
        (snapshot.servers[0] as { id: string }).id = 'server,with,commas';

        const exportData = createExportData(snapshot);
        const csvs = exportToCsv(exportData);

        // Value should be quoted
        expect(csvs.servers).toContain('"server,with,commas"');
      });

      it('should escape values with quotes', () => {
        const snapshot = createMockSnapshot();
        (snapshot.servers[0] as { id: string }).id = 'server"with"quotes';

        const exportData = createExportData(snapshot);
        const csvs = exportToCsv(exportData);

        // Quotes should be doubled and value quoted
        expect(csvs.servers).toContain('"server""with""quotes"');
      });

      it('should escape values with newlines', () => {
        const snapshot = createMockSnapshot();
        (snapshot.servers[0] as { id: string }).id = 'server\nwith\nnewlines';

        const exportData = createExportData(snapshot);
        const csvs = exportToCsv(exportData);

        // Value should be quoted
        expect(csvs.servers).toContain('"server\nwith\nnewlines"');
      });
    });

    describe('empty data handling', () => {
      it('should handle empty servers array', () => {
        const snapshot = createMockSnapshot();
        (snapshot as { servers: unknown[] }).servers = [];

        const exportData = createExportData(snapshot);
        const csvs = exportToCsv(exportData);

        const lines = csvs.servers.split('\n');
        expect(lines).toHaveLength(1); // Only headers
      });

      it('should handle empty supervisors array', () => {
        const snapshot = createMockSnapshot();
        (snapshot as { supervisors: unknown[] }).supervisors = [];

        const exportData = createExportData(snapshot);
        const csvs = exportToCsv(exportData);

        const lines = csvs.supervisors.split('\n');
        expect(lines).toHaveLength(1); // Only headers
      });
    });
  });

  describe('Observer.prepareExportData integration', () => {
    beforeEach(() => {
      // Clean up any existing servers/supervisors
      GenServer._clearLifecycleHandlers();
      GenServer._resetIdCounter();
      Supervisor._clearLifecycleHandlers();
      Supervisor._resetIdCounter();
      Registry._clearLifecycleHandler();
      Registry._clear();
      Observer._reset();
    });

    afterEach(async () => {
      // Cleanup
      Observer._reset();
      await Supervisor._clearAll();
      GenServer._clearLifecycleHandlers();
      Registry._clearLifecycleHandler();
      Registry._clear();
    });

    it('should prepare export data from current system state', async () => {
      // Start a simple server
      const ref = await GenServer.start({
        init: () => ({ count: 0 }),
        handleCall: (msg, state) => [state.count, state],
        handleCast: (msg, state) => state,
      });

      const exportData = Observer.prepareExportData();

      expect(exportData.version).toBe('1.0');
      expect(exportData.snapshot.servers.length).toBeGreaterThanOrEqual(1);
      expect(exportData.exportedAt).toBeLessThanOrEqual(Date.now());

      await GenServer.stop(ref);
    });

    it('should produce valid JSON export from Observer', async () => {
      const ref = await GenServer.start({
        init: () => ({}),
        handleCall: (msg, state) => [null, state],
        handleCast: (msg, state) => state,
      });

      const exportData = Observer.prepareExportData();
      const json = exportToJson(exportData);

      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json) as ExportData;
      expect(parsed.snapshot.memoryStats.heapUsed).toBeGreaterThan(0);

      await GenServer.stop(ref);
    });

    it('should produce valid CSV export from Observer', async () => {
      const ref = await GenServer.start({
        init: () => ({}),
        handleCall: (msg, state) => [null, state],
        handleCast: (msg, state) => state,
      });

      const exportData = Observer.prepareExportData();
      const csvs = exportToCsv(exportData);

      expect(csvs.summary).toContain('timestamp');
      expect(csvs.servers).toContain('id');
      expect(csvs.supervisors).toContain('strategy');

      await GenServer.stop(ref);
    });
  });
});
