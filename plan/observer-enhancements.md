# Observer Enhancements - Implementační plán

## Přehled

Rozšíření Observer modulu o 4 nové funkce:
1. Alerting při vysokém queue size (automatický práh)
2. Zastavení procesu z UI (s dialogem pro důvod)
3. Memory tracking (globální + per-server)
4. Export dat (JSON + CSV)

---

## Fáze 1: Memory Tracking ✅ DOKONČENO

### 1.1 Rozšíření typů (`src/core/types.ts`)

```typescript
// Přidat do GenServerStats
export interface GenServerStats {
  // ... existující pole ...
  readonly stateMemoryBytes?: number;  // Odhad velikosti state
}

// Nový typ pro globální memory metriky
export interface MemoryStats {
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
  readonly rss: number;
  readonly timestamp: number;
}

// Rozšířit ObserverSnapshot
export interface ObserverSnapshot {
  // ... existující pole ...
  readonly memoryStats: MemoryStats;
}
```

### 1.2 Utility pro odhad velikosti objektu (`src/observer/memory-utils.ts`)

```typescript
// Rekurzivní odhad velikosti objektu v bytech
export function estimateObjectSize(obj: unknown): number;
```

### 1.3 Rozšíření GenServer (`src/core/gen-server.ts`)

- Přidat `getStateMemoryEstimate()` do `ServerInstance`
- Volat `estimateObjectSize(this.state)` v `getStats()`

### 1.4 Rozšíření Observer (`src/observer/observer.ts`)

- Přidat `getMemoryStats(): MemoryStats` - wrapper nad `process.memoryUsage()`
- Zahrnout `memoryStats` do `getSnapshot()`

### Soubory k úpravě:
- `src/core/types.ts`
- `src/core/gen-server.ts`
- `src/observer/observer.ts`
- `src/observer/index.ts`

### Soubory k vytvoření:
- `src/observer/memory-utils.ts`

---

## Fáze 2: Alerting s automatickým prahem ✅ DOKONČENO

### 2.1 Nové typy pro alerting (`src/observer/types.ts`)

```typescript
export interface AlertConfig {
  readonly enabled: boolean;
  readonly sensitivityMultiplier: number;  // default 2.0 (průměr + 2*stddev)
  readonly minSamples: number;             // min vzorků pro výpočet (default 30)
  readonly cooldownMs: number;             // čas mezi alerty (default 10000)
}

export interface Alert {
  readonly id: string;
  readonly type: 'high_queue_size' | 'high_memory';
  readonly processId: string;
  readonly processName?: string;
  readonly threshold: number;
  readonly currentValue: number;
  readonly timestamp: number;
  readonly message: string;
}

export type AlertEvent =
  | { type: 'alert_triggered'; alert: Alert }
  | { type: 'alert_resolved'; alertId: string; processId: string };
```

### 2.2 Alert Manager (`src/observer/alert-manager.ts`)

```typescript
export const AlertManager = {
  // Konfigurace
  configure(config: Partial<AlertConfig>): void,
  getConfig(): AlertConfig,

  // Statistiky pro dynamický práh
  recordQueueSize(processId: string, size: number): void,
  getThreshold(processId: string): number,  // průměr + multiplier * stddev

  // Aktivní alerty
  getActiveAlerts(): Alert[],

  // Subscriptions
  subscribe(handler: (event: AlertEvent) => void): () => void,

  // Interní - volá Observer při stats update
  checkAlerts(stats: GenServerStats[]): void,
};
```

### 2.3 Integrace do Observer

- V `startPolling()` volat `AlertManager.checkAlerts()`
- Emitovat alert eventy přes WebSocket

### 2.4 WebSocket rozšíření (`examples/web-server/server.ts`)

- Přidat `AlertManager.subscribe()` do WS handleru
- Posílat `{ type: 'alert', data: AlertEvent }`

### Soubory k úpravě:
- `src/observer/types.ts`
- `src/observer/observer.ts`
- `src/observer/index.ts`
- `examples/web-server/server.ts`

### Soubory k vytvoření:
- `src/observer/alert-manager.ts`

---

## Fáze 3: Zastavení procesu z UI

### 3.1 Nový REST endpoint (`examples/web-server/server.ts`)

```typescript
// POST /api/processes/:id/stop
// Body: { reason?: string }
// Response: { success: boolean, message: string }
```

### 3.2 Rozšíření Observer API (`src/observer/observer.ts`)

```typescript
export const Observer = {
  // ... existující metody ...

  // Zastavit proces podle ID
  stopProcess(id: string, reason?: string): Result<void, string>,

  // Lookup ref podle ID (interně používá GenServer._getRefById)
};
```

### 3.3 Rozšíření GenServer (`src/core/gen-server.ts`)

- Přidat `_getRefById(id: string): GenServerRef | undefined`

### 3.4 UI změny (`examples/web-server/public/observer/index.html`)

- Přidat "Stop Process" tlačítko do detail panelu
- Modal dialog s:
  - Potvrzení ("Opravdu chcete zastavit proces X?")
  - Input pro důvod zastavení
  - Tlačítka: Zrušit / Zastavit
- Po zastavení zobrazit notifikaci

### Soubory k úpravě:
- `src/core/gen-server.ts`
- `src/observer/observer.ts`
- `examples/web-server/server.ts`
- `examples/web-server/public/observer/index.html`

---

## Fáze 4: Export dat ✅ DOKONČENO

### 4.1 Export utility (`src/observer/export-utils.ts`)

```typescript
export interface ExportData {
  snapshot: ObserverSnapshot;
  metricsHistory: {
    throughput: Array<{timestamp: number; value: number}>;
    processCount: Array<{timestamp: number; value: number}>;
    restartRate: Array<{timestamp: number; value: number}>;
    memory: Array<MemoryStats>;
    perProcess: Record<string, {
      queueSize: Array<{timestamp: number; value: number}>;
      messageCount: Array<{timestamp: number; value: number}>;
    }>;
  };
  exportedAt: number;
}

// JSON export
export function exportToJSON(data: ExportData): string;

// CSV export - vrací objekt s více CSV soubory
export function exportToCSV(data: ExportData): {
  summary: string;
  servers: string;
  supervisors: string;
  metricsHistory: string;
};
```

### 4.2 Rozšíření Observer API

```typescript
export const Observer = {
  // ... existující metody ...

  // Export funkce
  exportSnapshot(): ExportData,
};
```

### 4.3 REST endpointy (`examples/web-server/server.ts`)

```typescript
// GET /api/export/json - vrací JSON soubor
// GET /api/export/csv - vrací ZIP s CSV soubory (nebo jednotlivé CSV)
```

### 4.4 UI změny (`examples/web-server/public/observer/index.html`)

- Přidat export tlačítka do headeru nebo summary sekce
- Dropdown menu: "Export JSON" / "Export CSV"
- Stažení souboru přes browser

### Soubory k úpravě:
- `src/observer/observer.ts`
- `src/observer/index.ts`
- `examples/web-server/server.ts`
- `examples/web-server/public/observer/index.html`

### Soubory k vytvoření:
- `src/observer/export-utils.ts`

---

## Fáze 5: UI Integration - Alert zobrazení

### 5.1 Alert UI komponenty (`examples/web-server/public/observer/index.html`)

- Alert banner v horní části stránky (pod headerem)
- Badge/ikona u procesu s aktivním alertem v tree view
- Alert history panel (collapsible)
- Sound notification (volitelné)

### 5.2 Memory grafy v UI

- Přidat Memory chart do System Metrics sekce
- Zobrazit stateMemoryBytes v detail panelu GenServeru

---

## Souhrn změn

### Nové soubory:
1. `src/observer/memory-utils.ts` - odhad velikosti objektů
2. `src/observer/alert-manager.ts` - správa alertů
3. `src/observer/export-utils.ts` - export funkce

### Upravené soubory:
1. `src/core/types.ts` - nové typy (MemoryStats, stateMemoryBytes)
2. `src/core/gen-server.ts` - memory tracking, _getRefById
3. `src/observer/types.ts` - Alert typy
4. `src/observer/observer.ts` - nové metody (stopProcess, exportSnapshot, getMemoryStats)
5. `src/observer/index.ts` - exporty
6. `examples/web-server/server.ts` - nové REST endpointy
7. `examples/web-server/public/observer/index.html` - UI komponenty

---

## Pořadí implementace

1. **Memory tracking** - základ pro další funkce
2. **Export dat** - jednoduchá funkce, nezávisí na ostatních
3. **Alerting** - závisí na memory tracking pro memory alerty
4. **Stop process** - nezávislé, ale nejkomplexnější UI

---

## Rizika a poznámky

- **Memory odhad**: `estimateObjectSize()` je aproximace, nebude 100% přesná pro komplexní objekty s prototypy
- **Alert spam**: Cooldown a min samples zabrání falešným pozitivům
- **Stop process**: Zastavení supervisoru zastaví i všechny jeho children
- **CSV export**: Pro velké datasety může být pomalý, zvážit streaming
