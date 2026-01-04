#!/usr/bin/env python3
"""
Full-stack benchmark for Python asyncio
Equivalent to noex TypeScript benchmark
Tests: Actor (GenServer equivalent), Supervisor, Registry, EventBus, Cache
"""

import asyncio
import time
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, TypeVar
from collections import OrderedDict
import fnmatch

# ============================================================
# GenServer equivalent - Actor pattern with asyncio
# ============================================================

class Actor:
    """GenServer-like actor with message queue and serialized processing"""

    def __init__(self):
        self._state = 0
        self._queue: asyncio.Queue = asyncio.Queue()
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> 'Actor':
        self._state = 0  # init()
        self._running = True
        self._task = asyncio.create_task(self._process_loop())
        return self

    async def stop(self):
        if self._running:
            self._running = False
            await self._queue.put(('stop', None, None))
            if self._task:
                await self._task

    async def _process_loop(self):
        while self._running:
            msg_type, msg, future = await self._queue.get()
            if msg_type == 'stop':
                break
            elif msg_type == 'call':
                try:
                    result = self._handle_call(msg)
                    if future:
                        future.set_result(result)
                except Exception as e:
                    if future:
                        future.set_exception(e)
            elif msg_type == 'cast':
                self._handle_cast(msg)

    def _handle_call(self, msg: str) -> int:
        if msg == 'get':
            return self._state
        return self._state

    def _handle_cast(self, msg: str):
        if msg == 'inc':
            self._state += 1
        elif msg == 'dec':
            self._state -= 1

    async def call(self, msg: str) -> int:
        future = asyncio.get_event_loop().create_future()
        await self._queue.put(('call', msg, future))
        return await future

    def cast(self, msg: str):
        asyncio.create_task(self._queue.put(('cast', msg, None)))


# ============================================================
# Supervisor equivalent
# ============================================================

class Supervisor:
    """Supervisor that manages child actors"""

    def __init__(self):
        self._children: Dict[str, Actor] = {}

    async def start(self, child_specs: List[Dict]) -> 'Supervisor':
        for spec in child_specs:
            actor = await Actor().start()
            self._children[spec['id']] = actor
        return self

    async def stop(self):
        for actor in self._children.values():
            await actor.stop()
        self._children.clear()


# ============================================================
# Registry equivalent
# ============================================================

class Registry:
    """Named process lookup"""

    def __init__(self):
        self._registry: Dict[str, Any] = {}

    def register(self, name: str, ref: Any):
        self._registry[name] = ref

    def lookup(self, name: str) -> Any:
        if name not in self._registry:
            raise KeyError(f"Not registered: {name}")
        return self._registry[name]

    def unregister(self, name: str):
        if name in self._registry:
            del self._registry[name]


# ============================================================
# EventBus equivalent
# ============================================================

class EventBus:
    """Pub/sub with pattern matching"""

    def __init__(self):
        self._subscribers: List[tuple] = []
        self._queue: asyncio.Queue = asyncio.Queue()
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> 'EventBus':
        self._running = True
        self._task = asyncio.create_task(self._process_loop())
        return self

    async def stop(self):
        self._running = False
        await self._queue.put(None)
        if self._task:
            await self._task

    async def _process_loop(self):
        while self._running:
            item = await self._queue.get()
            if item is None:
                break
            topic, message = item
            for pattern, callback in self._subscribers:
                if fnmatch.fnmatch(topic, pattern):
                    callback(message, topic)

    def subscribe(self, pattern: str, callback: Callable):
        self._subscribers.append((pattern, callback))

    def publish(self, topic: str, message: Any):
        asyncio.create_task(self._queue.put((topic, message)))


# ============================================================
# Cache equivalent
# ============================================================

class Cache:
    """LRU Cache with async interface"""

    def __init__(self, max_size: int = 1000):
        self._data: OrderedDict = OrderedDict()
        self._max_size = max_size
        self._queue: asyncio.Queue = asyncio.Queue()
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> 'Cache':
        self._running = True
        self._task = asyncio.create_task(self._process_loop())
        return self

    async def stop(self):
        self._running = False
        await self._queue.put(None)
        if self._task:
            await self._task

    async def _process_loop(self):
        while self._running:
            item = await self._queue.get()
            if item is None:
                break
            op, key, value, future = item
            try:
                if op == 'set':
                    self._data[key] = value
                    if len(self._data) > self._max_size:
                        self._data.popitem(last=False)
                    if future:
                        future.set_result(None)
                elif op == 'get':
                    result = self._data.get(key)
                    if key in self._data:
                        self._data.move_to_end(key)
                    if future:
                        future.set_result(result)
            except Exception as e:
                if future:
                    future.set_exception(e)

    async def set(self, key: str, value: Any):
        future = asyncio.get_event_loop().create_future()
        await self._queue.put(('set', key, value, future))
        return await future

    async def get(self, key: str) -> Any:
        future = asyncio.get_event_loop().create_future()
        await self._queue.put(('get', key, None, future))
        return await future


# ============================================================
# Benchmarks
# ============================================================

@dataclass
class BenchmarkResult:
    name: str
    operations: int
    duration_ms: float
    ops_per_sec: int


results: List[BenchmarkResult] = []


def record(name: str, operations: int, duration_ms: float):
    ops_per_sec = int((operations / duration_ms) * 1000)
    results.append(BenchmarkResult(name, operations, duration_ms, ops_per_sec))
    print(f"  {name}: {operations} ops in {duration_ms:.2f}ms ({ops_per_sec:,} ops/sec)")


async def benchmark_actor_start_stop(iterations: int):
    start = time.perf_counter()

    for _ in range(iterations):
        actor = await Actor().start()
        await actor.stop()

    duration = (time.perf_counter() - start) * 1000
    record('Actor start/stop', iterations, duration)


async def benchmark_actor_cast(iterations: int):
    actor = await Actor().start()
    start = time.perf_counter()

    for _ in range(iterations):
        actor.cast('inc')

    # Wait for all casts to process
    await actor.call('get')

    duration = (time.perf_counter() - start) * 1000
    record('Actor cast', iterations, duration)
    await actor.stop()


async def benchmark_actor_call(iterations: int):
    actor = await Actor().start()
    start = time.perf_counter()

    for _ in range(iterations):
        await actor.call('get')

    duration = (time.perf_counter() - start) * 1000
    record('Actor call', iterations, duration)
    await actor.stop()


async def benchmark_supervisor_start_stop(child_count: int):
    start = time.perf_counter()

    supervisor = await Supervisor().start([
        {'id': f'worker-{i}'} for i in range(child_count)
    ])

    startup_time = (time.perf_counter() - start) * 1000

    stop_start = time.perf_counter()
    await supervisor.stop()
    shutdown_time = (time.perf_counter() - stop_start) * 1000

    record(f'Supervisor start ({child_count} children)', child_count, startup_time)
    record(f'Supervisor stop ({child_count} children)', child_count, shutdown_time)


async def benchmark_registry(iterations: int):
    registry = Registry()
    actors = []

    # Create actors
    for i in range(iterations):
        actors.append(await Actor().start())

    # Benchmark register
    start = time.perf_counter()
    for i in range(iterations):
        registry.register(f'service-{i}', actors[i])
    record('Registry register', iterations, (time.perf_counter() - start) * 1000)

    # Benchmark lookup
    start = time.perf_counter()
    for i in range(iterations):
        registry.lookup(f'service-{i}')
    record('Registry lookup', iterations, (time.perf_counter() - start) * 1000)

    # Cleanup
    for i in range(iterations):
        registry.unregister(f'service-{i}')
        await actors[i].stop()


async def benchmark_event_bus(publish_count: int, subscriber_count: int):
    bus = await EventBus().start()
    received = [0]

    # Add subscribers
    for _ in range(subscriber_count):
        bus.subscribe('test.*', lambda msg, topic: received.__setitem__(0, received[0] + 1))

    start = time.perf_counter()

    for i in range(publish_count):
        bus.publish('test.event', {'id': i})

    # Wait for events to be processed
    await asyncio.sleep(0.1)

    duration = (time.perf_counter() - start) * 1000
    record(f'EventBus publish ({subscriber_count} subs)', publish_count, duration)

    await bus.stop()


async def benchmark_cache(iterations: int):
    cache = await Cache(max_size=iterations + 100).start()

    # Benchmark set
    start = time.perf_counter()
    for i in range(iterations):
        await cache.set(f'key-{i}', {'value': i})
    record('Cache set', iterations, (time.perf_counter() - start) * 1000)

    # Benchmark get
    start = time.perf_counter()
    for i in range(iterations):
        await cache.get(f'key-{i}')
    record('Cache get', iterations, (time.perf_counter() - start) * 1000)

    await cache.stop()


async def benchmark_concurrent_calls(actor_count: int, calls_per_actor: int):
    actors = await asyncio.gather(*[Actor().start() for _ in range(actor_count)])

    start = time.perf_counter()

    tasks = []
    for actor in actors:
        for _ in range(calls_per_actor):
            tasks.append(actor.call('get'))

    await asyncio.gather(*tasks)

    total_ops = actor_count * calls_per_actor
    duration = (time.perf_counter() - start) * 1000
    record(f'Concurrent calls ({actor_count}x{calls_per_actor})', total_ops, duration)

    await asyncio.gather(*[a.stop() for a in actors])


async def main():
    print('\n=== Python asyncio Benchmark ===\n')

    print('Actor (GenServer equivalent):')
    await benchmark_actor_start_stop(1000)
    await benchmark_actor_cast(10000)
    await benchmark_actor_call(5000)

    print('\nSupervisor:')
    await benchmark_supervisor_start_stop(10)
    await benchmark_supervisor_start_stop(50)
    await benchmark_supervisor_start_stop(100)

    print('\nRegistry:')
    await benchmark_registry(1000)

    print('\nEventBus:')
    await benchmark_event_bus(1000, 10)
    await benchmark_event_bus(1000, 100)

    print('\nCache:')
    await benchmark_cache(5000)

    print('\nConcurrency:')
    await benchmark_concurrent_calls(10, 100)
    await benchmark_concurrent_calls(50, 100)

    print('\n=== Summary ===\n')
    print('| Benchmark | Operations | Duration (ms) | Ops/sec |')
    print('|-----------|------------|---------------|---------|')
    for r in results:
        print(f'| {r.name:<35} | {r.operations:>10} | {r.duration_ms:>13.2f} | {r.ops_per_sec:>7,} |')

    # Output JSON for comparison
    print('\n--- JSON Results ---')
    print(json.dumps([{
        'name': r.name,
        'operations': r.operations,
        'durationMs': r.duration_ms,
        'opsPerSec': r.ops_per_sec
    } for r in results], indent=2))


if __name__ == '__main__':
    asyncio.run(main())
