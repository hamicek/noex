import { describe, it, expect } from 'vitest';
import type {
  RegisterableRef,
  RegistryKeyMode,
  RegistryOptions,
  RegistryPersistenceConfig,
  RegistryEntry,
  RegistryPredicate,
  RegistryMatch,
  DispatchFn,
  SerializedRegistryEntry,
  PersistedRegistryState,
} from '../../src/core/registry-types.js';
import type { GenServerRef, SupervisorRef } from '../../src/core/types.js';
import type { StorageAdapter } from '../../src/persistence/types.js';

describe('Registry Types', () => {
  describe('RegistryKeyMode', () => {
    it('accepts unique and duplicate values', () => {
      const unique: RegistryKeyMode = 'unique';
      const duplicate: RegistryKeyMode = 'duplicate';
      expect(unique).toBe('unique');
      expect(duplicate).toBe('duplicate');
    });
  });

  describe('RegistryOptions', () => {
    it('allows empty options', () => {
      const opts: RegistryOptions = {};
      expect(opts).toEqual({});
    });

    it('accepts all configuration fields', () => {
      const mockAdapter = {
        save: async () => {},
        load: async () => undefined,
        delete: async () => false,
        exists: async () => false,
        listKeys: async () => [],
      } satisfies StorageAdapter;

      const opts: RegistryOptions = {
        name: 'my-registry',
        keys: 'duplicate',
        persistence: {
          adapter: mockAdapter,
          key: 'reg:state',
          restoreOnStart: true,
          persistOnChange: true,
          debounceMs: 200,
          persistOnShutdown: true,
          onError: () => {},
        },
      };

      expect(opts.name).toBe('my-registry');
      expect(opts.keys).toBe('duplicate');
      expect(opts.persistence?.debounceMs).toBe(200);
    });
  });

  describe('RegistryPersistenceConfig', () => {
    it('requires adapter field', () => {
      const mockAdapter = {
        save: async () => {},
        load: async () => undefined,
        delete: async () => false,
        exists: async () => false,
        listKeys: async () => [],
      } satisfies StorageAdapter;

      const config: RegistryPersistenceConfig = {
        adapter: mockAdapter,
      };

      expect(config.adapter).toBe(mockAdapter);
      expect(config.key).toBeUndefined();
      expect(config.restoreOnStart).toBeUndefined();
    });

    it('accepts onError callback', () => {
      const errors: Error[] = [];
      const mockAdapter = {
        save: async () => {},
        load: async () => undefined,
        delete: async () => false,
        exists: async () => false,
        listKeys: async () => [],
      } satisfies StorageAdapter;

      const config: RegistryPersistenceConfig = {
        adapter: mockAdapter,
        onError: (err) => errors.push(err),
      };

      config.onError?.(new Error('test'));
      expect(errors).toHaveLength(1);
    });
  });

  describe('RegistryEntry', () => {
    it('supports default unknown metadata', () => {
      const entry: RegistryEntry = {
        ref: { id: 'test-1' } as unknown as RegisterableRef,
        metadata: { role: 'worker' },
        registeredAt: Date.now(),
      };

      expect(entry.ref.id).toBe('test-1');
      expect(entry.registeredAt).toBeGreaterThan(0);
    });

    it('supports typed metadata generic', () => {
      interface NodeMeta {
        readonly weight: number;
        readonly region: string;
      }

      const entry: RegistryEntry<NodeMeta> = {
        ref: { id: 'node-1' } as unknown as RegisterableRef,
        metadata: { weight: 10, region: 'eu-west' },
        registeredAt: 1700000000000,
      };

      // TypeScript enforces metadata shape
      expect(entry.metadata.weight).toBe(10);
      expect(entry.metadata.region).toBe('eu-west');
    });
  });

  describe('RegistryPredicate', () => {
    it('filters entries by key and metadata', () => {
      interface ServiceMeta {
        readonly version: number;
      }

      const predicate: RegistryPredicate<ServiceMeta> = (key, entry) => {
        return key.startsWith('svc:') && entry.metadata.version >= 2;
      };

      const entry: RegistryEntry<ServiceMeta> = {
        ref: { id: 'ref-1' } as unknown as RegisterableRef,
        metadata: { version: 3 },
        registeredAt: Date.now(),
      };

      expect(predicate('svc:auth', entry)).toBe(true);
      expect(predicate('worker:1', entry)).toBe(false);
    });
  });

  describe('RegistryMatch', () => {
    it('represents a matched registry entry', () => {
      const match: RegistryMatch<{ priority: number }> = {
        key: 'handler:email',
        ref: { id: 'h-1' } as unknown as RegisterableRef,
        metadata: { priority: 5 },
      };

      expect(match.key).toBe('handler:email');
      expect(match.metadata.priority).toBe(5);
    });
  });

  describe('DispatchFn', () => {
    it('receives entries and dispatches message', () => {
      const dispatched: Array<{ ref: string; msg: unknown }> = [];

      const dispatch: DispatchFn<{ weight: number }> = (entries, message) => {
        for (const entry of entries) {
          dispatched.push({ ref: entry.ref.id, msg: message });
        }
      };

      const entries: ReadonlyArray<RegistryEntry<{ weight: number }>> = [
        { ref: { id: 'a' } as unknown as RegisterableRef, metadata: { weight: 1 }, registeredAt: 0 },
        { ref: { id: 'b' } as unknown as RegisterableRef, metadata: { weight: 2 }, registeredAt: 0 },
      ];

      dispatch(entries, { type: 'notify', payload: 'hello' });

      expect(dispatched).toHaveLength(2);
      expect(dispatched[0]!.ref).toBe('a');
      expect(dispatched[1]!.ref).toBe('b');
    });
  });

  describe('SerializedRegistryEntry', () => {
    it('stores entry in serializable form', () => {
      const serialized: SerializedRegistryEntry = {
        key: 'counter',
        refId: 'gs-42',
        metadata: { count: 10 },
        registeredAt: 1700000000000,
      };

      expect(serialized.key).toBe('counter');
      expect(serialized.refId).toBe('gs-42');
      expect(serialized.registeredAt).toBe(1700000000000);
    });
  });

  describe('PersistedRegistryState', () => {
    it('represents complete persisted snapshot', () => {
      const state: PersistedRegistryState = {
        registryName: 'services',
        keyMode: 'unique',
        entries: [
          { key: 'auth', refId: 'gs-1', metadata: null, registeredAt: 1000 },
          { key: 'cache', refId: 'gs-2', metadata: { ttl: 60 }, registeredAt: 2000 },
        ],
        persistedAt: 3000,
      };

      expect(state.registryName).toBe('services');
      expect(state.keyMode).toBe('unique');
      expect(state.entries).toHaveLength(2);
      expect(state.persistedAt).toBe(3000);
    });

    it('supports duplicate key mode in persistence', () => {
      const state: PersistedRegistryState = {
        registryName: 'pubsub',
        keyMode: 'duplicate',
        entries: [
          { key: 'topic:news', refId: 'gs-10', metadata: null, registeredAt: 100 },
          { key: 'topic:news', refId: 'gs-11', metadata: null, registeredAt: 200 },
          { key: 'topic:news', refId: 'gs-12', metadata: null, registeredAt: 300 },
        ],
        persistedAt: 400,
      };

      const newsEntries = state.entries.filter((e) => e.key === 'topic:news');
      expect(newsEntries).toHaveLength(3);
    });
  });

  describe('RegisterableRef type compatibility', () => {
    it('accepts GenServerRef', () => {
      const gsRef = { id: 'gs-1' } as unknown as GenServerRef;
      const ref: RegisterableRef = gsRef;
      expect(ref.id).toBe('gs-1');
    });

    it('accepts SupervisorRef', () => {
      const supRef = { id: 'sup-1' } as unknown as SupervisorRef;
      const ref: RegisterableRef = supRef;
      expect(ref.id).toBe('sup-1');
    });
  });
});
