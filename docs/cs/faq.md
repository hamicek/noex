# Často kladené otázky

Běžné otázky o noex a jejich odpovědi.

---

## Obecné

### Co je noex?

noex je TypeScript knihovna, která přináší vzory konkurence ve stylu Elixir/OTP do Node.js. Poskytuje:

- **GenServer**: Stavové procesy s komunikací založenou na zprávách
- **Supervisor**: Automatická obnova po pádu a správa procesů
- **Registry**: Vyhledávání pojmenovaných procesů
- **Vestavěné služby**: Cache, EventBus, RateLimiter

### Proč použít noex místo čistého JavaScript/TypeScript?

noex poskytuje několik výhod:

1. **Žádné race conditions**: Každý GenServer zpracovává zprávy jednu po druhé
2. **Odolnost vůči chybám**: Supervisoři automaticky restartují spadlé procesy
3. **Čistá správa stavu**: Stav je zapouzdřený a měněn pouze přes zprávy
4. **Známé vzory**: Pokud znáte Elixir/OTP, budete se cítit jako doma

### Je noex vhodný pro produkci?

noex je navržen pro produkční použití. Klíčové vlastnosti:

- Komplexní pokrytí testy
- TypeScript pro typovou bezpečnost
- Pozorovatelnost přes vestavěný Observer a Dashboard
- Dobře zdokumentované API

### Jak se noex srovnává s Elixir/OTP?

noex implementuje základní vzory z Elixir/OTP:

| Elixir/OTP | noex | Poznámky |
|------------|------|----------|
| GenServer | GenServer | Podobné API |
| Supervisor | Supervisor | Stejné strategie |
| Registry | Registry | Pojmenovaná vyhledávání |
| GenStage | - | Zatím neimplementováno |
| Phoenix.PubSub | EventBus | Pub/sub založené na tématech |

Klíčové rozdíly:

- noex běží v jediném Node.js procesu (žádný BEAM VM)
- Žádné distribuované funkce (zatím)
- JavaScript event loop místo preemptivního plánování

---

## GenServer

### Kdy použít call vs cast?

- **call**: Když potřebujete odpověď nebo potvrzení
  ```typescript
  const value = await GenServer.call(ref, 'get');
  ```

- **cast**: Fire-and-forget, když nepotřebujete odpověď
  ```typescript
  GenServer.cast(ref, 'increment');
  ```

### Mohou být handleCall a handleCast asynchronní?

Ano, oba handlery mohou být async:

```typescript
handleCall: async (msg, state) => {
  const data = await fetchData();
  return [data, state];
},

handleCast: async (msg, state) => {
  await saveToDatabase(state);
  return state;
},
```

### Co se stane, když GenServer spadne?

Pokud není supervizován, GenServer se zastaví a reference se stane neplatnou. Následná volání vyhodí `ServerNotRunningError`.

Pokud je supervizován, Supervisor ho restartuje podle své strategie restartování.

### Jak ošetřit timeouty v call?

Použijte volbu `timeout`:

```typescript
try {
  const result = await GenServer.call(ref, msg, { timeout: 5000 });
} catch (error) {
  if (error instanceof CallTimeoutError) {
    // Ošetřit timeout
  }
}
```

### Mohu mít více GenServerů stejného typu?

Ano. Každé `GenServer.start()` vytvoří nezávislou instanci:

```typescript
const counter1 = await GenServer.start(counterBehavior);
const counter2 = await GenServer.start(counterBehavior);
// Tyto jsou zcela nezávislé
```

---

## Supervisor

### Kterou strategii restartování použít?

- **one_for_one**: Potomci jsou nezávislí
  - Příklad: Více nezávislých worker procesů

- **one_for_all**: Potomci na sobě závisí
  - Příklad: Úzce propojené služby sdílející stav

- **rest_for_one**: Pozdější potomci závisí na dřívějších
  - Příklad: Pool databázových spojení, na kterém závisí ostatní služby

### Jaké možnosti restartu jsou k dispozici?

- **permanent**: Vždy restartovat (výchozí)
- **temporary**: Nikdy nerestartovat
- **transient**: Restartovat pouze při abnormálním ukončení

### Jak zabránit nekonečným smyčkám restartů?

Nakonfigurujte intenzitu restartování:

```typescript
await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: {
    maxRestarts: 5,
    withinMs: 60_000, // max 5 restartů za minutu
  },
  children: [...],
});
```

### Mohu přidávat/odebírat potomky dynamicky?

Ano, použijte `startChild` a `terminateChild`:

```typescript
// Přidat potomka
await Supervisor.startChild(supervisor, {
  id: 'new-worker',
  start: () => GenServer.start(workerBehavior),
  restart: 'permanent',
});

// Odebrat potomka
await Supervisor.terminateChild(supervisor, 'new-worker');
```

---

## Registry

### Jak registrovat proces podle jména?

Registrujte během startu nebo poté:

```typescript
// Během startu
const ref = await GenServer.start(behavior, { name: 'my-service' });

// Nebo registrovat později
await Registry.register('my-service', ref);
```

### Jak vyhledat registrovaný proces?

```typescript
const ref = Registry.lookup('my-service');
if (ref) {
  await GenServer.call(ref, 'get');
}
```

### Co se stane, když registrovaný proces spadne?

Registrace je automaticky odstraněna. Pokud je proces supervizován a restartuje se, musíte ho znovu zaregistrovat (typicky v `init` callbacku).

---

## Výkon

### Kolik GenServerů mohu spustit?

Tisíce až desítky tisíc, v závislosti na vaší zátěži. Každý GenServer je lehký - jen objekt s frontou zpráv.

### Jsou zprávy zpracovávány v pořadí?

Ano. Každý GenServer zpracovává zprávy jednu po druhé v pořadí, v jakém byly přijaty. To eliminuje race conditions.

### Je noex vhodný pro aplikace s vysokou propustností?

Ano, ale zvažte:

- GenServery jsou jednovláknové (jedna zpráva najednou)
- Použijte worker pooly pro CPU-náročné úlohy
- Zvažte horizontální škálování pro velmi vysokou propustnost

---

## Ladění

### Jak zjistím, co se děje v mých GenServerech?

Použijte Observer:

```typescript
import { Observer } from 'noex';

const observer = await Observer.start();

// Získat snapshot všech procesů
const snapshot = await Observer.getSnapshot(observer);
console.log(snapshot);

// Přihlásit se k odběru událostí
await Observer.subscribe(observer, (event) => {
  console.log('Událost:', event);
});
```

### Jak zapnout Dashboard?

```typescript
import { DashboardServer } from 'noex';

const dashboard = await DashboardServer.start({
  port: 8080,
});

// Otevřete http://localhost:8080 v prohlížeči
```

### Můj GenServer vypadá zaseknutý. Co zkontrolovat?

1. **Zkontrolujte, zda běží**: `GenServer.isRunning(ref)`
2. **Zkontrolujte stav**: Přidejte `get_state` call zprávu pro ladění
3. **Zkontrolujte blokující operace**: Vyhněte se blokování event loopu
4. **Použijte Observer**: Zkontrolujte délku fronty zpráv a časy zpracování

---

## Běžné chyby

### CallTimeoutError

GenServer neodpověděl v rámci timeout periody.

**Příčiny**:
- Handler trvá příliš dlouho
- GenServer zpracovává mnoho zpráv
- Deadlock (volání GenServeru z jeho vlastního handleru)

**Řešení**:
- Zvyšte timeout, pokud jsou operace legitimně pomalé
- Použijte cast místo call pro neblokující operace
- Vyhněte se volání stejného GenServeru z jeho handleru

### ServerNotRunningError

GenServer neběží.

**Příčiny**:
- GenServer byl zastaven
- GenServer spadl a nebyl supervizován

**Řešení**:
- Zkontrolujte, zda GenServer běží před voláním
- Použijte Supervisor pro automatický restart spadlých procesů

### MaxRestartsExceededError

Supervisor to vzdal po příliš mnoha restartech.

**Příčiny**:
- Potomek stále opakovaně padá
- Inicializace stále selhává

**Řešení**:
- Zkontrolujte init funkci potomka na chyby
- Přehodnoťte nastavení intenzity restartování
- Opravte základní příčinu pádů

---

## Související

- [Začínáme](./getting-started/index.md) - Rychlý úvod
- [API Reference](./api/index.md) - Kompletní API dokumentace
- [Tutoriály](./tutorials/index.md) - Průvodci krok za krokem
