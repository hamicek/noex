/**
 * Registry chapter example - Key-Value Store with helper functions
 * Run with: npx tsx docs/learn/02-basics/examples/registry-example.ts
 */

import {
  GenServer,
  Registry,
  NotRegisteredError,
  type GenServerBehavior,
} from '../../../../src/index.js';

// Types
interface KVState {
  data: Map<string, unknown>;
}

type KVCallMsg =
  | { type: 'get'; key: string }
  | { type: 'set'; key: string; value: unknown }
  | { type: 'keys' };

type KVCastMsg = { type: 'delete'; key: string };

type KVReply = unknown | string[];

// Behavior
const kvStoreBehavior: GenServerBehavior<KVState, KVCallMsg, KVCastMsg, KVReply> = {
  init() {
    return { data: new Map() };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.data.get(msg.key), state];

      case 'set': {
        const newData = new Map(state.data);
        newData.set(msg.key, msg.value);
        return [msg.value, { data: newData }];
      }

      case 'keys':
        return [Array.from(state.data.keys()), state];
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'delete') {
      const newData = new Map(state.data);
      newData.delete(msg.key);
      return { data: newData };
    }
    return state;
  },
};

// Helper module
const KV_STORE_NAME = 'kv-store';

function getStore() {
  return Registry.lookup<KVState, KVCallMsg, KVCastMsg, KVReply>(KV_STORE_NAME);
}

async function kvGet<T = unknown>(key: string): Promise<T | undefined> {
  const store = getStore();
  return (await GenServer.call(store, { type: 'get', key })) as T | undefined;
}

async function kvSet<T>(key: string, value: T): Promise<T> {
  const store = getStore();
  return (await GenServer.call(store, { type: 'set', key, value })) as T;
}

function kvDelete(key: string): void {
  const store = getStore();
  GenServer.cast(store, { type: 'delete', key });
}

async function kvKeys(): Promise<string[]> {
  const store = getStore();
  return (await GenServer.call(store, { type: 'keys' })) as string[];
}

// Test
async function main() {
  console.log('=== Registry Example: Key-Value Store ===\n');

  // Start and register the store
  const storeRef = await GenServer.start(kvStoreBehavior);
  Registry.register(KV_STORE_NAME, storeRef);
  console.log('KV Store started and registered');

  // Test the helper functions (no references needed!)
  await kvSet('user:1', { name: 'Alice', age: 30 });
  await kvSet('user:2', { name: 'Bob', age: 25 });
  await kvSet('config:theme', 'dark');

  console.log('\nStored values:');
  console.log('user:1 =', await kvGet('user:1'));
  console.log('user:2 =', await kvGet('user:2'));
  console.log('config:theme =', await kvGet('config:theme'));
  console.log('missing =', await kvGet('missing'));

  console.log('\nAll keys:', await kvKeys());

  // Test delete
  kvDelete('user:2');
  await new Promise((r) => setTimeout(r, 10));
  console.log('\nAfter deleting user:2:');
  console.log('user:2 =', await kvGet('user:2'));
  console.log('All keys:', await kvKeys());

  // Test automatic cleanup
  console.log('\nStopping store...');
  await GenServer.stop(storeRef);
  console.log('Store registered:', Registry.isRegistered(KV_STORE_NAME));

  // This should throw NotRegisteredError
  try {
    await kvGet('user:1');
  } catch (error) {
    if (error instanceof NotRegisteredError) {
      console.log(`\nExpected error: Store '${error.processName}' is not registered`);
    }
  }

  console.log('\n=== Test passed! ===');
}

main().catch(console.error);
