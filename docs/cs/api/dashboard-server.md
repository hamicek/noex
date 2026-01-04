# DashboardServer API Reference

`DashboardServer` zpřístupňuje data dashboardu přes TCP, umožňuje vzdáleným klientům dashboardu připojit se a přijímat real-time aktualizace. Postavený na GenServeru pro spolehlivý provoz.

## Import

```typescript
import { DashboardServer } from 'noex';
// Nebo ze submodulu
import { DashboardServer } from 'noex/dashboard';
```

## Přehled

DashboardServer poskytuje:

- **TCP Server**: Naslouchá připojením klientů dashboardu
- **Real-time aktualizace**: Broadcastuje Observer snímky všem klientům
- **Streaming událostí**: Předává události životního cyklu klientům
- **Vzdálené ovládání**: Umožňuje klientům vzdáleně zastavovat procesy
- **Verzování protokolu**: Zajišťuje kompatibilitu klient-server

## Typy

### DashboardServerRef

Neprůhledná reference na běžící instanci DashboardServeru.

```typescript
type DashboardServerRef = GenServerRef<
  DashboardServerState,
  DashboardServerCallMsg,
  DashboardServerCastMsg,
  DashboardServerReply
>;
```

### DashboardServerConfig

Konfigurační volby pro server.

```typescript
interface DashboardServerConfig {
  /**
   * TCP port pro naslouchání.
   * @default 9876
   */
  readonly port: number;

  /**
   * Adresa hostitele pro binding.
   * @default '127.0.0.1'
   */
  readonly host: string;

  /**
   * Interval dotazování v milisekundách pro aktualizace statistik.
   * @default 500
   */
  readonly pollingIntervalMs: number;
}
```

### ServerStatus

Informace o stavu vrácené metodou `getStatus()`.

```typescript
interface ServerStatus {
  readonly status: 'running';
  readonly port: number;
  readonly host: string;
  readonly clientCount: number;
  readonly uptime: number;
}
```

---

## Metody

### start()

Spustí DashboardServer.

```typescript
async start(config?: Partial<DashboardServerConfig>): Promise<DashboardServerRef>
```

Vytvoří TCP server, který naslouchá připojením klientů dashboardu a broadcastuje aktualizace dat z Observeru.

**Parametry:**
- `config` - Volitelná konfigurace
  - `port` - TCP port (výchozí: 9876)
  - `host` - Adresa hostitele (výchozí: '127.0.0.1')
  - `pollingIntervalMs` - Interval aktualizací (výchozí: 500)

**Vrací:** Promise resolvující na DashboardServerRef

**Příklad:**
```typescript
// Spuštění s výchozími hodnotami (localhost:9876)
const server = await DashboardServer.start();

// Spuštění na vlastním portu
const server = await DashboardServer.start({ port: 8080 });

// Binding na všechna rozhraní
const server = await DashboardServer.start({
  port: 9876,
  host: '0.0.0.0',
});

// Pomalejší aktualizace pro spojení s nízkou šířkou pásma
const server = await DashboardServer.start({
  pollingIntervalMs: 2000,
});
```

---

### stop()

Zastaví DashboardServer.

```typescript
async stop(ref: DashboardServerRef): Promise<void>
```

Uzavře všechna klientská připojení a TCP server.

**Parametry:**
- `ref` - Reference na server k zastavení

**Příklad:**
```typescript
await DashboardServer.stop(server);
```

---

### getStatus()

Získá aktuální stav DashboardServeru.

```typescript
async getStatus(ref: DashboardServerRef): Promise<ServerStatus>
```

**Parametry:**
- `ref` - Reference na server

**Vrací:** Informace o stavu

**Příklad:**
```typescript
const status = await DashboardServer.getStatus(server);

console.log(`Server běží na ${status.host}:${status.port}`);
console.log(`Připojených klientů: ${status.clientCount}`);
console.log(`Uptime: ${Math.floor(status.uptime / 1000)}s`);
```

---

### getClientCount()

Získá počet připojených klientů.

```typescript
async getClientCount(ref: DashboardServerRef): Promise<number>
```

**Parametry:**
- `ref` - Reference na server

**Vrací:** Počet připojených klientů

**Příklad:**
```typescript
const count = await DashboardServer.getClientCount(server);
console.log(`${count} klientů připojeno`);
```

---

## Protokol

DashboardServer používá binární protokol pro komunikaci. Zprávy jsou rámovány 4-bajtovým prefixem délky následovaným JSON payloadem.

### Serverové zprávy

Zprávy odesílané ze serveru klientům:

```typescript
type ServerMessage =
  | { type: 'welcome'; payload: { version: number; serverUptime: number } }
  | { type: 'snapshot'; payload: ObserverSnapshot }
  | { type: 'event'; payload: ObserverEvent }
  | { type: 'error'; payload: { code: string; message: string } };
```

### Klientské zprávy

Zprávy odesílané z klientů na server:

```typescript
type ClientMessage =
  | { type: 'get_snapshot' }
  | { type: 'stop_process'; payload: { processId: string; reason?: string } }
  | { type: 'ping' };
```

---

## Kompletní příklad

```typescript
import { DashboardServer, GenServer, Supervisor } from 'noex';

async function main() {
  // Vytvoření procesů k monitorování
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'worker-1',
        start: () => GenServer.start({
          init: () => ({ count: 0 }),
          handleCall: (msg, state) => [state.count, state],
          handleCast: (msg, state) => ({ count: state.count + 1 }),
        }),
      },
      {
        id: 'worker-2',
        start: () => GenServer.start({
          init: () => ({ count: 0 }),
          handleCall: (msg, state) => [state.count, state],
          handleCast: (msg, state) => ({ count: state.count + 1 }),
        }),
      },
    ],
  });

  // Spuštění dashboard serveru
  const dashboardServer = await DashboardServer.start({
    port: 9876,
    host: '0.0.0.0', // Přijímat připojení z jakéhokoliv rozhraní
    pollingIntervalMs: 500,
  });

  const status = await DashboardServer.getStatus(dashboardServer);
  console.log(`Dashboard server běží na ${status.host}:${status.port}`);
  console.log('Připojte se klientem dashboardu pro monitoring procesů');

  // Periodické logování počtu připojení
  setInterval(async () => {
    const count = await DashboardServer.getClientCount(dashboardServer);
    if (count > 0) {
      console.log(`${count} klient(ů) dashboardu připojeno`);
    }
  }, 10000);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Ukončuji...');
    await DashboardServer.stop(dashboardServer);
    await Supervisor.stop(supervisor);
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Bezpečnostní aspekty

1. **Lokální binding**: Ve výchozím nastavení se připojuje pouze na `127.0.0.1` (pouze localhost)
2. **Síťová expozice**: Používejte `0.0.0.0` pouze na důvěryhodných sítích
3. **Bez autentizace**: Aktuálně bez vestavěné autentizace
4. **Ovládání procesů**: Klienti mohou zastavovat procesy - omezte přístup odpovídajícím způsobem
5. **Firewall**: Zvažte pravidla firewallu pro produkční nasazení

---

## Případy použití

### Vývojový monitoring

```typescript
// Spuštění serveru pro lokální vývoj
if (process.env.NODE_ENV === 'development') {
  await DashboardServer.start({ port: 9876 });
}
```

### Produkční monitoring

```typescript
// Pouze localhost připojení v produkci
await DashboardServer.start({
  port: 9876,
  host: '127.0.0.1',
  pollingIntervalMs: 1000, // Méně časté aktualizace
});
```

### Docker/Container monitoring

```typescript
// Binding na IP kontejneru pro inter-container přístup
await DashboardServer.start({
  port: 9876,
  host: '0.0.0.0',
});
```

---

## Související

- [Dashboard API](./dashboard.md) - TUI klient
- [Observer API](./observer.md) - Zdroj dat
- [GenServer API](./genserver.md) - Implementace serveru
