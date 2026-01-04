# noex Observer - Implementační plán

## Cíl
Vytvořit Observer modul pro vizualizaci a monitoring GenServerů a Supervisorů, podobně jako Elixir Observer.

## Architektura

```
┌─────────────────────────────────────────────────────────┐
│                    noex Observer                         │
├─────────────────────────────────────────────────────────┤
│  Process Tree          │  Selected: connection_42       │
│  ─────────────         │  ────────────────────────      │
│  ▼ root-supervisor     │  Status: running               │
│    ├─ event-bus        │  Uptime: 4m 23s                │
│    ├─ cache            │  Queue:  2 messages            │
│    ├─ metrics          │  Messages: 1,234               │
│    └─▼ connections     │                                │
│        ├─ conn_1       │                                │
│        └─ conn_2       │                                │
└─────────────────────────────────────────────────────────┘
```

---

## Fáze 1: Core typy a rozšíření ✅

### 1.1 Nové typy v `src/core/types.ts`

```typescript
// Statistiky GenServeru
export interface GenServerStats {
  readonly id: string;
  readonly status: ServerStatus;
  readonly queueSize: number;
  readonly messageCount: number;
  readonly startedAt: number;
  readonly uptimeMs: number;
}

// Statistiky Supervisoru
export interface SupervisorStats {
  readonly id: string;
  readonly strategy: SupervisorStrategy;
  readonly childCount: number;
  readonly totalRestarts: number;
  readonly startedAt: number;
  readonly uptimeMs: number;
}

// Uzel stromu procesů
export interface ProcessTreeNode {
  readonly type: 'genserver' | 'supervisor';
  readonly id: string;
  readonly name?: string;
  readonly stats: GenServerStats | SupervisorStats;
  readonly children?: ProcessTreeNode[];
}

// Observer eventy pro real-time updates
export type ObserverEvent =
  | { type: 'server_started'; stats: GenServerStats }
  | { type: 'server_stopped'; id: string; reason: TerminateReason }
  | { type: 'supervisor_started'; stats: SupervisorStats }
  | { type: 'supervisor_stopped'; id: string }
  | { type: 'stats_update'; servers: GenServerStats[]; supervisors: SupervisorStats[] };
```

### 1.2 Rozšíření `src/core/gen-server.ts`

**Přidat do `ServerInstance`:**
- `private readonly startedAt: number = Date.now();`
- `private messageCount: number = 0;`
- `getStats(): GenServerStats` metoda
- Inkrementace `messageCount` v `handleCallMessage` a `handleCastMessage`

**Přidat do `GenServer` objektu:**
- `_getStats(ref)` - statistiky jednoho serveru
- `_getAllStats()` - statistiky všech serverů
- `_getAllServerIds()` - seznam všech ID

### 1.3 Rozšíření `src/core/supervisor.ts`

**Přidat do `SupervisorInstance`:**
- `private readonly startedAt: number = Date.now();`
- `private totalRestarts: number = 0;`
- `getStats(): SupervisorStats` metoda

**Přidat do `Supervisor` objektu:**
- `_getStats(ref)` - statistiky jednoho supervisoru
- `_getAllStats()` - statistiky všech supervisorů
- `_getAllSupervisorIds()` - seznam všech ID
- `_getRefById(id)` - lookup ref podle ID

---

## Fáze 2: Observer modul ✅

### Struktura `src/observer/`

```
src/observer/
├── index.ts          # Public exports
├── types.ts          # Observer-specifické typy
├── tree-builder.ts   # Logika pro stavbu process tree
└── observer.ts       # Hlavní Observer API
```

### 2.1 `src/observer/observer.ts` - Hlavní API

```typescript
export const Observer = {
  // Kompletní snapshot systému
  getSnapshot(): ObserverSnapshot,

  // Jednotlivé části
  getServerStats(): GenServerStats[],
  getSupervisorStats(): SupervisorStats[],
  getProcessTree(): ProcessTreeNode[],

  // Real-time events
  subscribe(handler): () => void,

  // Polling pro WebSocket
  startPolling(intervalMs, handler): () => void,
}
```

### 2.2 `src/observer/tree-builder.ts`

- `buildProcessTree()` - sestaví hierarchii z Supervisor children
- Propojí supervisory s jejich GenServer children
- Přidá názvy z Registry

### 2.3 Export v `src/index.ts`

```typescript
export { Observer } from './observer/index.js';
export type { GenServerStats, SupervisorStats, ProcessTreeNode, ObserverEvent } from './core/types.js';
```

---

## Fáze 3: Web integrace ✅

### 3.1 Nové routes v `examples/web-server/server.ts`

| Endpoint | Popis |
|----------|-------|
| `GET /observer/snapshot` | Kompletní snapshot |
| `GET /observer/tree` | Process tree |
| `GET /observer/servers` | GenServer statistiky |
| `GET /observer/supervisors` | Supervisor statistiky |
| `WS /observer/ws` | Real-time updates |

### 3.2 WebSocket endpoint

```typescript
app.get('/observer/ws', { websocket: true }, (socket) => {
  // Poslat initial snapshot
  socket.send(JSON.stringify({ type: 'snapshot', data: Observer.getSnapshot() }));

  // Subscribe na lifecycle events
  const unsubEvents = Observer.subscribe((event) => {
    socket.send(JSON.stringify({ type: 'event', data: event }));
  });

  // Polling pro stats updates (každou sekundu)
  const stopPolling = Observer.startPolling(1000, (event) => {
    socket.send(JSON.stringify({ type: 'event', data: event }));
  });

  socket.on('close', () => { unsubEvents(); stopPolling(); });
});
```

### 3.3 Dashboard `examples/web-server/public/observer/index.html`

- Summary cards (počet serverů, supervisorů, zpráv, restartů)
- Interaktivní process tree (kliknutím zobrazí detail)
- Detail panel s metrikami vybraného procesu
- Real-time aktualizace přes WebSocket

---

## Soubory k úpravě/vytvoření

### Upravit:
1. `src/core/types.ts` - přidat nové typy
2. `src/core/gen-server.ts` - přidat tracking a introspekci
3. `src/core/supervisor.ts` - přidat tracking a introspekci
4. `src/index.ts` - přidat exporty
5. `examples/web-server/server.ts` - přidat Observer routes

### Vytvořit:
1. `src/observer/types.ts`
2. `src/observer/tree-builder.ts`
3. `src/observer/observer.ts`
4. `src/observer/index.ts`
5. `examples/web-server/public/observer/index.html`

---

## Pořadí implementace

1. **Core typy** (`types.ts`)
2. **GenServer introspekce** (`gen-server.ts`)
3. **Supervisor introspekce** (`supervisor.ts`)
4. **Observer modul** (`src/observer/*`)
5. **Export** (`src/index.ts`)
6. **Web routes** (`server.ts`)
7. **Dashboard UI** (`observer/index.html`)

---

## Budoucí vylepšení (mimo scope)

- Historické grafy metrik
- Alerting při vysokém queue size
- Možnost zastavit proces z UI
- Memory tracking
- Export dat
