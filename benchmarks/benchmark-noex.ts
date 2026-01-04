/**
 * Full-stack benchmark for noex library
 * Tests: GenServer, Supervisor, Registry, EventBus, Cache
 */

import { GenServer, Supervisor, Registry, EventBus, Cache } from '../src/index.js';

interface BenchmarkResult {
  name: string;
  operations: number;
  durationMs: number;
  opsPerSec: number;
}

const results: BenchmarkResult[] = [];

function record(name: string, operations: number, durationMs: number) {
  const opsPerSec = Math.round((operations / durationMs) * 1000);
  results.push({ name, operations, durationMs, opsPerSec });
  console.log(`  ${name}: ${operations} ops in ${durationMs.toFixed(2)}ms (${opsPerSec.toLocaleString()} ops/sec)`);
}

// Counter behavior for benchmarking
const counterBehavior = {
  init: () => 0,
  handleCall: (msg: 'get', state: number) => [state, state] as const,
  handleCast: (msg: 'inc' | 'dec', state: number) => (msg === 'inc' ? state + 1 : state - 1),
};

async function benchmarkGenServerStartStop(iterations: number) {
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    const ref = await GenServer.start(counterBehavior);
    await GenServer.stop(ref);
  }

  record('GenServer start/stop', iterations, performance.now() - start);
}

async function benchmarkGenServerCast(iterations: number) {
  const ref = await GenServer.start(counterBehavior);
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    GenServer.cast(ref, 'inc');
  }

  // Wait for all casts to process
  await GenServer.call(ref, 'get');

  record('GenServer cast', iterations, performance.now() - start);
  await GenServer.stop(ref);
}

async function benchmarkGenServerCall(iterations: number) {
  const ref = await GenServer.start(counterBehavior);
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    await GenServer.call(ref, 'get');
  }

  record('GenServer call', iterations, performance.now() - start);
  await GenServer.stop(ref);
}

async function benchmarkSupervisorStartStop(childCount: number) {
  const start = performance.now();

  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: Array.from({ length: childCount }, (_, i) => ({
      id: `worker-${i}`,
      start: () => GenServer.start(counterBehavior),
    })),
  });

  const startupTime = performance.now() - start;

  const stopStart = performance.now();
  await Supervisor.stop(supervisor);
  const shutdownTime = performance.now() - stopStart;

  record(`Supervisor start (${childCount} children)`, childCount, startupTime);
  record(`Supervisor stop (${childCount} children)`, childCount, shutdownTime);
}

async function benchmarkRegistry(iterations: number) {
  const refs: Array<{ id: string }> = [];

  // Create refs
  for (let i = 0; i < iterations; i++) {
    refs.push(await GenServer.start(counterBehavior));
  }

  // Benchmark register
  const registerStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    Registry.register(`service-${i}`, refs[i]);
  }
  record('Registry register', iterations, performance.now() - registerStart);

  // Benchmark lookup
  const lookupStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    Registry.lookup(`service-${i}`);
  }
  record('Registry lookup', iterations, performance.now() - lookupStart);

  // Cleanup
  for (let i = 0; i < iterations; i++) {
    Registry.unregister(`service-${i}`);
    await GenServer.stop(refs[i] as any);
  }
}

async function benchmarkEventBus(publishCount: number, subscriberCount: number) {
  const bus = await EventBus.start();
  let received = 0;

  // Add subscribers
  for (let i = 0; i < subscriberCount; i++) {
    await EventBus.subscribe(bus, 'test.*', () => {
      received++;
    });
  }

  const start = performance.now();

  for (let i = 0; i < publishCount; i++) {
    EventBus.publish(bus, 'test.event', { id: i });
  }

  // Wait for all events to be processed
  await new Promise((resolve) => setTimeout(resolve, 100));

  record(`EventBus publish (${subscriberCount} subs)`, publishCount, performance.now() - start);

  await EventBus.stop(bus);
}

async function benchmarkCache(iterations: number) {
  const cache = await Cache.start({ maxSize: iterations + 100 });

  // Benchmark set
  const setStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    await Cache.set(cache, `key-${i}`, { value: i });
  }
  record('Cache set', iterations, performance.now() - setStart);

  // Benchmark get
  const getStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    await Cache.get(cache, `key-${i}`);
  }
  record('Cache get', iterations, performance.now() - getStart);

  await Cache.stop(cache);
}

async function benchmarkConcurrentCalls(serverCount: number, callsPerServer: number) {
  const servers = await Promise.all(
    Array.from({ length: serverCount }, () => GenServer.start(counterBehavior))
  );

  const start = performance.now();

  await Promise.all(
    servers.flatMap((server) =>
      Array.from({ length: callsPerServer }, () => GenServer.call(server, 'get'))
    )
  );

  const totalOps = serverCount * callsPerServer;
  record(`Concurrent calls (${serverCount}x${callsPerServer})`, totalOps, performance.now() - start);

  await Promise.all(servers.map((s) => GenServer.stop(s)));
}

async function main() {
  console.log('\n=== noex Benchmark (TypeScript) ===\n');

  console.log('GenServer:');
  await benchmarkGenServerStartStop(1000);
  await benchmarkGenServerCast(10000);
  await benchmarkGenServerCall(5000);

  console.log('\nSupervisor:');
  await benchmarkSupervisorStartStop(10);
  await benchmarkSupervisorStartStop(50);
  await benchmarkSupervisorStartStop(100);

  console.log('\nRegistry:');
  await benchmarkRegistry(1000);

  console.log('\nEventBus:');
  await benchmarkEventBus(1000, 10);
  await benchmarkEventBus(1000, 100);

  console.log('\nCache:');
  await benchmarkCache(5000);

  console.log('\nConcurrency:');
  await benchmarkConcurrentCalls(10, 100);
  await benchmarkConcurrentCalls(50, 100);

  console.log('\n=== Summary ===\n');
  console.log('| Benchmark | Operations | Duration (ms) | Ops/sec |');
  console.log('|-----------|------------|---------------|---------|');
  for (const r of results) {
    console.log(`| ${r.name.padEnd(35)} | ${r.operations.toString().padStart(10)} | ${r.durationMs.toFixed(2).padStart(13)} | ${r.opsPerSec.toLocaleString().padStart(7)} |`);
  }

  // Output JSON for comparison
  console.log('\n--- JSON Results ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
