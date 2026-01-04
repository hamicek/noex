# Reference typů

Tento dokument poskytuje kompletní referenci pro všechny typy exportované knihovnou noex.

## Import

```typescript
import type {
  GenServerRef,
  GenServerBehavior,
  CallResult,
  TerminateReason,
  StartOptions,
  CallOptions,
  SupervisorRef,
  SupervisorOptions,
  SupervisorStrategy,
  ChildSpec,
  ChildRestartStrategy,
  ChildInfo,
  RestartIntensity,
  LifecycleEvent,
  LifecycleHandler,
  GenServerStats,
  SupervisorStats,
  MemoryStats,
  ProcessTreeNode,
  ObserverEvent,
  ServerStatus,
} from 'noex';
```

---

## Typy GenServeru

### GenServerRef

Neprůhledná reference na běžící instanci GenServeru.

```typescript
interface GenServerRef<
  State = unknown,
  CallMsg = unknown,
  CastMsg = unknown,
  CallReply = unknown,
> {
  readonly id: string;
}
```

Typové parametry poskytují compile-time typovou bezpečnost pro zprávy:

- `State` - Typ interního stavu serveru
- `CallMsg` - Union všech typů synchronních call zpráv
- `CastMsg` - Union všech typů asynchronních cast zpráv
- `CallReply` - Union všech možných typů odpovědí na call

**Příklad:**
```typescript
type MyRef = GenServerRef<
  { count: number },           // State
  { type: 'get' },             // CallMsg
  { type: 'increment' },       // CastMsg
  number                       // CallReply
>;
```

---

### GenServerBehavior

Rozhraní, které musí implementace GenServeru splňovat.

```typescript
interface GenServerBehavior<State, CallMsg, CastMsg, CallReply> {
  init(): State | Promise<State>;

  handleCall(
    msg: CallMsg,
    state: State,
  ): CallResult<CallReply, State> | Promise<CallResult<CallReply, State>>;

  handleCast(msg: CastMsg, state: State): State | Promise<State>;

  terminate?(reason: TerminateReason, state: State): void | Promise<void>;
}
```

**Callbacky:**

| Callback | Povinný | Popis |
|----------|---------|-------|
| `init` | Ano | Inicializace stavu serveru |
| `handleCall` | Ano | Zpracování synchronních zpráv |
| `handleCast` | Ano | Zpracování asynchronních zpráv |
| `terminate` | Ne | Úklid při ukončení |

---

### CallResult

Návratový typ pro `handleCall`.

```typescript
type CallResult<Reply, State> = readonly [Reply, State];
```

Vrací tuple `[reply, newState]`.

---

### TerminateReason

Důvod ukončení GenServeru.

```typescript
type TerminateReason = 'normal' | 'shutdown' | { readonly error: Error };
```

| Hodnota | Popis |
|---------|-------|
| `'normal'` | Graceful shutdown přes `stop()` |
| `'shutdown'` | Ukončení iniciované Supervisorem |
| `{ error: Error }` | Pád kvůli nezpracované výjimce |

---

### StartOptions

Volby pro `GenServer.start()`.

```typescript
interface StartOptions {
  /** Registrovat server pod tímto jménem */
  readonly name?: string;

  /** Timeout pro init() v milisekundách @default 5000 */
  readonly initTimeout?: number;
}
```

---

### CallOptions

Volby pro `GenServer.call()`.

```typescript
interface CallOptions {
  /** Timeout pro call v milisekundách @default 5000 */
  readonly timeout?: number;
}
```

---

## Typy Supervisoru

### SupervisorRef

Reference na běžící instanci Supervisoru.

```typescript
interface SupervisorRef {
  readonly id: string;
}
```

---

### SupervisorOptions

Volby pro `Supervisor.start()`.

```typescript
interface SupervisorOptions {
  /** Strategie restartu @default 'one_for_one' */
  readonly strategy?: SupervisorStrategy;

  /** Počáteční specifikace potomků */
  readonly children?: readonly ChildSpec[];

  /** Konfigurace intenzity restartu */
  readonly restartIntensity?: RestartIntensity;

  /** Volitelné jméno pro registry */
  readonly name?: string;
}
```

---

### SupervisorStrategy

Strategie pro restartování potomků, když jeden selže.

```typescript
type SupervisorStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one';
```

| Strategie | Popis |
|-----------|-------|
| `'one_for_one'` | Restartovat pouze spadlého potomka |
| `'one_for_all'` | Restartovat všechny potomky, když jeden selže |
| `'rest_for_one'` | Restartovat spadlého potomka a všechny potomky spuštěné po něm |

---

### ChildSpec

Specifikace pro potomka spravovaného Supervisorem.

```typescript
interface ChildSpec<
  State = unknown,
  CallMsg = unknown,
  CastMsg = unknown,
  CallReply = unknown,
> {
  /** Unikátní identifikátor tohoto potomka */
  readonly id: string;

  /** Tovární funkce pro spuštění potomka */
  readonly start: () => Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>>;

  /** Strategie restartu @default 'permanent' */
  readonly restart?: ChildRestartStrategy;

  /** Timeout pro ukončení v milisekundách @default 5000 */
  readonly shutdownTimeout?: number;
}
```

---

### ChildRestartStrategy

Strategie restartu pro jednotlivé potomky.

```typescript
type ChildRestartStrategy = 'permanent' | 'transient' | 'temporary';
```

| Strategie | Popis |
|-----------|-------|
| `'permanent'` | Vždy restartovat, bez ohledu na důvod ukončení |
| `'transient'` | Restartovat pouze při abnormálním ukončení (chyba) |
| `'temporary'` | Nikdy nerestartovat |

---

### ChildInfo

Informace o běžícím potomkovi v supervisoru.

```typescript
interface ChildInfo {
  readonly id: string;
  readonly ref: GenServerRef;
  readonly spec: ChildSpec;
  readonly restartCount: number;
}
```

---

### RestartIntensity

Konfigurace pro omezení intenzity restartů supervisoru.

```typescript
interface RestartIntensity {
  /** Maximální povolený počet restartů @default 3 */
  readonly maxRestarts: number;

  /** Časové okno v milisekundách @default 5000 */
  readonly withinMs: number;
}
```

Pokud je `maxRestarts` překročeno během `withinMs`, supervisor se ukončí.

---

## Typy životního cyklu

### LifecycleEvent

Události emitované GenServery a Supervisory.

```typescript
type LifecycleEvent =
  | { readonly type: 'started'; readonly ref: GenServerRef | SupervisorRef }
  | { readonly type: 'crashed'; readonly ref: GenServerRef; readonly error: Error }
  | { readonly type: 'restarted'; readonly ref: GenServerRef; readonly attempt: number }
  | { readonly type: 'terminated'; readonly ref: GenServerRef | SupervisorRef; readonly reason: TerminateReason };
```

---

### LifecycleHandler

Handler funkce pro události životního cyklu.

```typescript
type LifecycleHandler = (event: LifecycleEvent) => void;
```

---

## Typy Observeru

### GenServerStats

Runtime statistiky pro instanci GenServeru.

```typescript
interface GenServerStats {
  /** Unikátní identifikátor */
  readonly id: string;

  /** Aktuální stav */
  readonly status: ServerStatus;

  /** Zprávy čekající ve frontě */
  readonly queueSize: number;

  /** Celkový počet zpracovaných zpráv */
  readonly messageCount: number;

  /** Časové razítko spuštění (Unix ms) */
  readonly startedAt: number;

  /** Uptime v milisekundách */
  readonly uptimeMs: number;

  /** Odhadovaná paměť stavu v bytech */
  readonly stateMemoryBytes?: number;
}
```

---

### SupervisorStats

Runtime statistiky pro instanci Supervisoru.

```typescript
interface SupervisorStats {
  /** Unikátní identifikátor */
  readonly id: string;

  /** Strategie restartu */
  readonly strategy: SupervisorStrategy;

  /** Počet potomků */
  readonly childCount: number;

  /** Celkový počet provedených restartů */
  readonly totalRestarts: number;

  /** Časové razítko spuštění (Unix ms) */
  readonly startedAt: number;

  /** Uptime v milisekundách */
  readonly uptimeMs: number;
}
```

---

### MemoryStats

Statistiky paměti Node.js procesu.

```typescript
interface MemoryStats {
  /** V8 heap použitý (byty) */
  readonly heapUsed: number;

  /** V8 heap celkem (byty) */
  readonly heapTotal: number;

  /** Paměť C++ objektů (byty) */
  readonly external: number;

  /** Resident Set Size (byty) */
  readonly rss: number;

  /** Časové razítko sběru */
  readonly timestamp: number;
}
```

---

### ProcessTreeNode

Uzel v hierarchii stromu procesů.

```typescript
interface ProcessTreeNode {
  /** Typ procesu */
  readonly type: 'genserver' | 'supervisor';

  /** Unikátní identifikátor */
  readonly id: string;

  /** Volitelné registrované jméno */
  readonly name?: string;

  /** Runtime statistiky */
  readonly stats: GenServerStats | SupervisorStats;

  /** Potomci (pouze supervisory) */
  readonly children?: readonly ProcessTreeNode[];
}
```

---

### ObserverEvent

Události emitované Observerem.

```typescript
type ObserverEvent =
  | { readonly type: 'server_started'; readonly stats: GenServerStats }
  | { readonly type: 'server_stopped'; readonly id: string; readonly reason: TerminateReason }
  | { readonly type: 'supervisor_started'; readonly stats: SupervisorStats }
  | { readonly type: 'supervisor_stopped'; readonly id: string }
  | { readonly type: 'stats_update'; readonly servers: readonly GenServerStats[]; readonly supervisors: readonly SupervisorStats[] };
```

---

### ServerStatus

Interní stav GenServeru.

```typescript
type ServerStatus = 'initializing' | 'running' | 'stopping' | 'stopped';
```

---

## Výchozí hodnoty

Konstanty pro výchozí konfigurační hodnoty.

```typescript
const DEFAULTS = {
  INIT_TIMEOUT: 5000,      // Timeout init GenServeru
  CALL_TIMEOUT: 5000,      // Timeout call GenServeru
  SHUTDOWN_TIMEOUT: 5000,  // Timeout ukončení potomka
  MAX_RESTARTS: 3,         // Max intenzity restartu
  RESTART_WITHIN_MS: 5000, // Okno intenzity restartu
} as const;
```

---

## Související

- [GenServer API](./genserver.md) - Metody GenServeru
- [Supervisor API](./supervisor.md) - Metody Supervisoru
- [Reference chyb](./errors.md) - Třídy chyb
