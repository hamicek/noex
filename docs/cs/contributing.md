# Přispívání do noex

Děkujeme za váš zájem přispět do noex! Tento průvodce vám pomůže začít.

## Kodex chování

Účastí na tomto projektu souhlasíte s udržováním přívětivého a inkluzivního prostředí pro všechny.

## Začínáme

### Předpoklady

- Node.js 18+
- npm nebo yarn
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
│   ├── core/           # GenServer, Supervisor, Registry
│   ├── services/       # Cache, EventBus, RateLimiter
│   ├── observer/       # Observer, AlertManager
│   └── dashboard/      # Dashboard server
├── tests/              # Testovací soubory
├── examples/           # Ukázkové aplikace
└── docs/               # Dokumentace
```

### Spouštění testů

```bash
# Spustit všechny testy
npm test

# Spustit testy ve watch módu
npm run test:watch

# Spustit testy s pokrytím
npm run test:coverage
```

### Sestavení

```bash
# Sestavit projekt
npm run build

# Kontrola typů bez sestavení
npm run typecheck
```

### Linting

```bash
# Spustit linter
npm run lint

# Opravit problémy lintingu
npm run lint:fix
```

## Provádění změn

### Styl kódu

- Používejte TypeScript pro všechny zdrojové soubory
- Dodržujte existující vzory kódu
- Přidávejte JSDoc komentáře pro veřejná API
- Udržujte funkce zaměřené a malé

### Zprávy commitů

Používejte jasné, popisné zprávy commitů:

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

Všechny nové funkce by měly obsahovat testy:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, type GenServerBehavior } from '../src';

describe('MojeFunkce', () => {
  let ref: GenServerRef;

  beforeEach(async () => {
    ref = await GenServer.start(myBehavior);
  });

  afterEach(async () => {
    if (GenServer.isRunning(ref)) {
      await GenServer.stop(ref);
    }
  });

  it('měla by dělat něco', async () => {
    const result = await GenServer.call(ref, 'test');
    expect(result).toBe(expectedValue);
  });
});
```

### Dokumentace

Pro nové funkce:

1. Přidejte JSDoc komentáře do kódu
2. Aktualizujte příslušné dokumentační soubory v `docs/`
3. Přidejte příklady, pokud je to vhodné

## Proces Pull Requestu

1. **Aktualizujte dokumentaci**, pokud jste změnili API
2. **Přidejte testy** pro novou funkcionalitu
3. **Spusťte testovací sadu** a ujistěte se, že všechny testy prochází
4. **Aktualizujte changelog**, pokud je to relevantní
5. **Odešlete pull request** s jasným popisem

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
- [ ] Changelog aktualizován (pokud relevantní)
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
