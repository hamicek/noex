# Začínáme s distribucí

Tento návod vás provede vytvořením první distribuované aplikace v noex. Vytvoříme jednoduchý cluster se dvěma uzly komunikujícími přes síť.

## Předpoklady

- Node.js 18+
- TypeScript 5.0+
- Základní znalost GenServer (viz [GenServer dokumentace](../../concepts/genserver.md))

## Struktura projektu

```
distributed-app/
├── package.json
├── tsconfig.json
├── shared/
│   ├── behaviors.ts    # Sdílená behaviour definice
│   └── types.ts        # Sdílené typy
├── node1.ts            # První uzel (seed)
└── node2.ts            # Druhý uzel
```

## Krok 1: Nastavení projektu

```bash
mkdir distributed-app
cd distributed-app
npm init -y
npm install noex typescript tsx
```

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["*.ts", "shared/**/*.ts"]
}
```

## Krok 2: Definice sdílených typů a behaviour

**shared/types.ts:**
```typescript
export type CounterCallMsg =
  | { type: 'get' }
  | { type: 'get_info' };

export type CounterCastMsg =
  | { type: 'increment'; by?: number }
  | { type: 'decrement'; by?: number };

export type CounterCallReply =
  | number
  | { value: number; nodeId: string };
```

**shared/behaviors.ts:**
```typescript
import type { GenServerBehavior } from 'noex';
import { Cluster } from 'noex/distribution';
import type { CounterCallMsg, CounterCastMsg, CounterCallReply } from './types.js';

interface CounterState {
  value: number;
  createdAt: Date;
}

export const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCallMsg,
  CounterCastMsg,
  CounterCallReply
> = {
  init: () => ({
    value: 0,
    createdAt: new Date(),
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.value, state];

      case 'get_info':
        return [
          {
            value: state.value,
            nodeId: Cluster.getLocalNodeId() as string,
          },
          state,
        ];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'increment': {
        const by = msg.by ?? 1;
        console.log(`[Counter] Increment by ${by}`);
        return { ...state, value: state.value + by };
      }

      case 'decrement': {
        const by = msg.by ?? 1;
        console.log(`[Counter] Decrement by ${by}`);
        return { ...state, value: state.value - by };
      }
    }
  },

  terminate: (reason, state) => {
    console.log(`[Counter] Ukončen s hodnotou ${state.value}: ${reason}`);
  },
};
```

## Krok 3: Seed uzel (Node 1)

**node1.ts:**
```typescript
import { GenServer } from 'noex';
import {
  Cluster,
  BehaviorRegistry,
  GlobalRegistry,
} from 'noex/distribution';
import { counterBehavior } from './shared/behaviors.js';

async function main(): Promise<void> {
  console.log('=== Node 1 (Seed) ===\n');

  // 1. Registrace behaviour PŘED startem clusteru
  BehaviorRegistry.register('counter', counterBehavior);
  console.log('✓ Behaviour registrováno');

  // 2. Start clusteru jako seed uzel (bez seeds)
  await Cluster.start({
    nodeName: 'node1',
    port: 4369,
    // Žádné seeds - tento uzel je seed
  });
  console.log(`✓ Cluster spuštěn: ${Cluster.getLocalNodeId()}`);

  // 3. Sledování událostí clusteru
  Cluster.onNodeUp((node) => {
    console.log(`\n[Cluster] Uzel připojen: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    console.log(`\n[Cluster] Uzel odpojen: ${nodeId} (${reason})`);
  });

  // 4. Vytvoření lokálního counter serveru
  const counterRef = await GenServer.start(counterBehavior);
  console.log(`✓ Counter server spuštěn: ${counterRef.id}`);

  // 5. Registrace v GlobalRegistry
  await GlobalRegistry.register('main-counter', {
    id: counterRef.id,
    nodeId: Cluster.getLocalNodeId(),
  });
  console.log('✓ Counter registrován globálně jako "main-counter"');

  // 6. Periodické vypisování stavu
  setInterval(async () => {
    const value = await GenServer.call<number>(counterRef, { type: 'get' });
    const nodes = Cluster.getConnectedNodes();
    console.log(`\n[Status] Counter: ${value}, Uzly: ${nodes.length}`);
  }, 5000);

  // 7. Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\nUkončuji...');
    await GlobalRegistry.unregister('main-counter');
    await GenServer.stop(counterRef);
    await Cluster.stop();
    console.log('Hotovo');
    process.exit(0);
  });

  console.log('\n✓ Node 1 připraven. Čeká na připojení...\n');
  console.log('Spusťte node2.ts v jiném terminálu');
  console.log('Pro ukončení stiskněte Ctrl+C\n');
}

main().catch(console.error);
```

## Krok 4: Klient uzel (Node 2)

**node2.ts:**
```typescript
import {
  Cluster,
  BehaviorRegistry,
  GlobalRegistry,
  RemoteCall,
  RemoteSpawn,
} from 'noex/distribution';
import { counterBehavior } from './shared/behaviors.js';
import type { CounterCallReply } from './shared/types.js';

async function main(): Promise<void> {
  console.log('=== Node 2 (Klient) ===\n');

  // 1. Registrace behaviour
  BehaviorRegistry.register('counter', counterBehavior);
  console.log('✓ Behaviour registrováno');

  // 2. Start clusteru s připojením k seed uzlu
  await Cluster.start({
    nodeName: 'node2',
    port: 4370,
    seeds: ['node1@localhost:4369'],
  });
  console.log(`✓ Cluster spuštěn: ${Cluster.getLocalNodeId()}`);

  // 3. Sledování událostí
  Cluster.onNodeUp((node) => {
    console.log(`[Cluster] Uzel připojen: ${node.id}`);
  });

  // 4. Počkáme na připojení
  console.log('Čekám na připojení k node1...');
  await waitForConnection();
  console.log('✓ Připojeno k clusteru\n');

  // 5. Najdeme vzdálený counter
  const counterRef = GlobalRegistry.whereis('main-counter');
  if (!counterRef) {
    console.error('Counter "main-counter" nenalezen v GlobalRegistry');
    await Cluster.stop();
    process.exit(1);
  }
  console.log(`✓ Nalezen counter na ${counterRef.nodeId}`);

  // 6. Vzdálené operace
  console.log('\n--- Vzdálené operace ---\n');

  // Get aktuální hodnoty
  const initialValue = await RemoteCall.call<number>(counterRef, { type: 'get' });
  console.log(`Počáteční hodnota: ${initialValue}`);

  // Increment (cast - fire-and-forget)
  console.log('Posílám increment...');
  RemoteCall.cast(counterRef, { type: 'increment', by: 5 });

  // Malá pauza pro zpracování
  await sleep(100);

  // Get nové hodnoty
  const newValue = await RemoteCall.call<number>(counterRef, { type: 'get' });
  console.log(`Nová hodnota: ${newValue}`);

  // Get info s nodeId
  const info = await RemoteCall.call<CounterCallReply>(counterRef, { type: 'get_info' });
  console.log(`Info:`, info);

  // 7. Spawn vzdáleného procesu
  console.log('\n--- Vzdálený spawn ---\n');

  const nodes = Cluster.getConnectedNodes();
  if (nodes.length > 0) {
    const targetNode = nodes[0]!;
    console.log(`Spawnuji counter na ${targetNode.id}...`);

    const result = await RemoteSpawn.spawn('counter', targetNode.id, {
      name: 'remote-counter',
      registration: 'global',
    });
    console.log(`✓ Spawned: ${result.serverId} na ${result.nodeId}`);

    // Použití nového vzdáleného counteru
    const remoteRef = GlobalRegistry.whereis('remote-counter');
    if (remoteRef) {
      RemoteCall.cast(remoteRef, { type: 'increment', by: 10 });
      await sleep(100);
      const val = await RemoteCall.call<number>(remoteRef, { type: 'get' });
      console.log(`Remote counter hodnota: ${val}`);
    }
  }

  // 8. Statistiky
  console.log('\n--- Statistiky ---\n');
  const callStats = RemoteCall.getStats();
  console.log(`RemoteCall stats:`);
  console.log(`  Celkem volání: ${callStats.totalCalls}`);
  console.log(`  Úspěšných: ${callStats.totalResolved}`);
  console.log(`  Celkem castů: ${callStats.totalCasts}`);

  const spawnStats = RemoteSpawn.getStats();
  console.log(`RemoteSpawn stats:`);
  console.log(`  Celkem spawnů: ${spawnStats.totalInitiated}`);
  console.log(`  Úspěšných: ${spawnStats.totalResolved}`);

  // 9. Graceful shutdown
  console.log('\n✓ Demo dokončeno. Ukončuji za 3 sekundy...');
  await sleep(3000);

  await Cluster.stop();
  console.log('Hotovo');
  process.exit(0);
}

async function waitForConnection(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (Cluster.getConnectedNodeCount() > 0) {
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
```

## Krok 5: Spuštění

**Terminál 1:**
```bash
npx tsx node1.ts
```

Výstup:
```
=== Node 1 (Seed) ===

✓ Behaviour registrováno
✓ Cluster spuštěn: node1@localhost:4369
✓ Counter server spuštěn: genserver_abc123
✓ Counter registrován globálně jako "main-counter"

✓ Node 1 připraven. Čeká na připojení...
Spusťte node2.ts v jiném terminálu
```

**Terminál 2:**
```bash
npx tsx node2.ts
```

Výstup:
```
=== Node 2 (Klient) ===

✓ Behaviour registrováno
✓ Cluster spuštěn: node2@localhost:4370
Čekám na připojení k node1...
[Cluster] Uzel připojen: node1@localhost:4369
✓ Připojeno k clusteru

✓ Nalezen counter na node1@localhost:4369

--- Vzdálené operace ---

Počáteční hodnota: 0
Posílám increment...
Nová hodnota: 5
Info: { value: 5, nodeId: 'node1@localhost:4369' }

--- Vzdálený spawn ---

Spawnuji counter na node1@localhost:4369...
✓ Spawned: genserver_xyz789 na node1@localhost:4369
Remote counter hodnota: 10

--- Statistiky ---

RemoteCall stats:
  Celkem volání: 4
  Úspěšných: 4
  Celkem castů: 2
RemoteSpawn stats:
  Celkem spawnů: 1
  Úspěšných: 1

✓ Demo dokončeno. Ukončuji za 3 sekundy...
```

## Co jsme se naučili

1. **BehaviorRegistry** - Registrace behaviour před startem clusteru
2. **Cluster.start()** - Spuštění uzlu s/bez seed uzlů
3. **GlobalRegistry** - Globální pojmenování procesů
4. **RemoteCall.call/cast** - Vzdálená komunikace
5. **RemoteSpawn** - Vzdálené spouštění procesů
6. **Cluster události** - Sledování připojení/odpojení uzlů

## Další kroky

- [Formace clusteru](./cluster-formation.md) - Pokročilá konfigurace
- [Vzdálené procesy](./remote-processes.md) - Detailní práce s RemoteSpawn
- [Monitorování procesů](./process-monitoring.md) - Sledování stavu procesů
- [Produkční nasazení](./production-deployment.md) - Docker, Kubernetes

---

*[English version](../../../distribution/guides/getting-started.md)*
