# Přispívání do noex

Děkujeme za váš zájem přispět do noex! Tento průvodce vám pomůže začít.

## Kodex chování

Účastí na tomto projektu souhlasíte s udržováním přívětivého a inkluzivního prostředí pro všechny.

## Začínáme

### Předpoklady

- Node.js 20+
- npm
- Git

### Nastavení

1. Forkněte repozitář na GitHubu

2. Naklonujte svůj fork:
   ```bash
   git clone https://github.com/VASE_UZIVATELSKE_JMENO/noex.git
   cd noex
   ```

3. Nainstalujte závislosti:
   ```bash
   npm install
   ```

4. Vytvořte větev pro vaše změny:
   ```bash
   git checkout -b feature/nazev-vasi-funkce
   ```

## Vývoj

### Struktura projektu

```
noex/
├── src/
│   ├── core/           # GenServer, Supervisor, Registry, linkování procesů
│   ├── services/       # Cache, EventBus, RateLimiter, TimerService
│   ├── observer/       # Observer, AlertManager
│   ├── dashboard/      # Dashboard server
│   ├── distribution/   # Cluster, RemoteCall, RemoteSpawn, RemoteLink
│   ├── persistence/    # Storage adaptery, EventLog, PersistenceManager
│   └── bin/            # CLI nástroje (noex-init, noex-dashboard)
├── tests/              # Testovací soubory (zrcadlí strukturu src/)
├── examples/           # Ukázkové aplikace
├── docs/               # Dokumentace
└── noex-website/       # Webové stránky projektu (Astro + Svelte)
```

### Spouštění testů

```bash
# Spustit všechny testy
npm test

# Spustit testy ve watch módu
npm run test:watch
```

### Sestavení

```bash
# Sestavit projekt
npm run build

# Kontrola typů bez sestavení
npm run typecheck

# Vyčistit build artefakty
npm run clean
```

## Provádění změn

### Styl kódu

- Používejte TypeScript pro všechny zdrojové soubory
- Dodržujte existující vzory kódu
- Udržujte funkce zaměřené a malé

### Zprávy commitů

Používejte formát [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: přidán algoritmus posuvného okna pro rate limiter
fix: ošetření timeoutu v GenServer.call
docs: vylepšení API dokumentace Supervisoru
test: přidány testy pro hraniční případy Registry
refactor: zjednodušení implementace fronty zpráv
```

Prefixy:
- `feat`: Nová funkce
- `fix`: Oprava chyby
- `docs`: Změny dokumentace
- `test`: Změny testů
- `refactor`: Refaktoring kódu
- `chore`: Změny buildu/nástrojů

### Psaní testů

Všechny nové funkce by měly obsahovat testy. Testy používají [Vitest](https://vitest.dev/) a sledují behaviorální vzor:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { GenServer, type GenServerBehavior, type GenServerRef } from '../src/index.js';

function createCounterBehavior(): GenServerBehavior<number, 'get', 'inc', number> {
  return {
    init: () => 0,
    handleCall: (msg, state) => {
      if (msg === 'get') return [state, state];
      return [state, state];
    },
    handleCast: (msg, state) => {
      if (msg === 'inc') return state + 1;
      return state;
    },
  };
}

describe('Counter', () => {
  let ref: GenServerRef;

  afterEach(async () => {
    if (GenServer.isRunning(ref)) {
      await GenServer.stop(ref);
    }
  });

  it('měl by inkrementovat', async () => {
    ref = await GenServer.start(createCounterBehavior());
    await GenServer.cast(ref, 'inc');
    const value = await GenServer.call(ref, 'get');
    expect(value).toBe(1);
  });
});
```

### Dokumentace

Pro nové funkce:

1. Přidejte příslušnou dokumentaci v `docs/`
2. Přidejte příklady, pokud je to vhodné
3. Aktualizujte EN i CS verze, pokud je to relevantní

## Proces Pull Requestu

1. **Přidejte testy** pro novou funkcionalitu
2. **Spusťte testovací sadu** a ujistěte se, že všechny testy prochází
3. **Aktualizujte dokumentaci**, pokud jste změnili API
4. **Odešlete pull request** s jasným popisem

### Formát názvu PR

```
feat: Přidán burst mód pro rate limiter
fix: Prevence race condition v Registry
docs: Přidán tutoriál pro worker pooly
```

### Šablona popisu PR

```markdown
## Popis
Stručný popis změn.

## Typ změny
- [ ] Oprava chyby
- [ ] Nová funkce
- [ ] Breaking change
- [ ] Aktualizace dokumentace

## Testování
Popište, jak jste tyto změny testovali.

## Checklist
- [ ] Testy prochází lokálně
- [ ] Kód dodržuje styl projektu
- [ ] Dokumentace aktualizována
```

## Hlášení problémů

### Hlášení chyb

Uveďte:
- Verze noex
- Verze Node.js
- Operační systém
- Kroky k reprodukci
- Očekávané vs skutečné chování
- Minimální reprodukční kód

### Požadavky na funkce

Uveďte:
- Jasný popis funkce
- Případ použití / motivace
- Navrhované API (pokud relevantní)
- Příklady podobných funkcí v jiných knihovnách

## Otázky?

- Otevřete issue pro otázky ohledně přispívání
- Zkontrolujte existující issues a PR pro podobnou práci
- Přečtěte si dokumentaci pro pochopení kódové báze

## Licence

Přispíváním souhlasíte s tím, že vaše příspěvky budou licencovány pod stejnou licencí jako projekt (MIT).
