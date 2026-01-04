# Instalace

## Požadavky

- **Node.js**: 20.0.0 nebo novější
- **TypeScript**: 5.0+ (doporučeno, ale není nutné)

## Instalace balíčku

### npm

```bash
npm install noex
```

### yarn

```bash
yarn add noex
```

### pnpm

```bash
pnpm add noex
```

## Konfigurace TypeScript

noex je napsán v TypeScriptu a dodává se s definicemi typů. Pro nejlepší zážitek zajistěte, aby váš `tsconfig.json` obsahoval:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true
  }
}
```

## Volitelné závislosti

### Dashboard (TUI)

Vestavěný terminálový dashboard vyžaduje `blessed` a `blessed-contrib`:

```bash
npm install blessed blessed-contrib
```

Bez těchto balíčků základní knihovna funguje správně, ale funkce Dashboard nebudou dostupné.

## Ověření instalace

Vytvořte jednoduchý testovací soubor pro ověření, že vše funguje:

```typescript
// test.ts
import { GenServer } from 'noex';

const server = await GenServer.start({
  init: () => ({ count: 0 }),
  handleCall: (msg: 'get', state) => [state.count, state],
  handleCast: (msg: 'inc', state) => ({ count: state.count + 1 }),
});

GenServer.cast(server, 'inc');
const value = await GenServer.call(server, 'get');
console.log('Count:', value); // Count: 1

await GenServer.stop(server);
console.log('noex funguje!');
```

Spusťte ho:

```bash
npx tsx test.ts
```

Pokud vidíte "noex funguje!", jste připraveni!

## Struktura projektu

Typický noex projekt může vypadat takto:

```
my-app/
├── src/
│   ├── services/          # Vaše GenServer implementace
│   │   ├── user-service.ts
│   │   └── cache-service.ts
│   ├── supervisors/       # Konfigurace Supervisorů
│   │   └── app-supervisor.ts
│   └── index.ts           # Vstupní bod aplikace
├── package.json
└── tsconfig.json
```

## ESM vs CommonJS

noex je distribuován jako ESM (ECMAScript Modules). Ujistěte se, že váš projekt je nakonfigurován pro ESM:

**Možnost 1**: Nastavte `"type": "module"` v `package.json`:

```json
{
  "type": "module"
}
```

**Možnost 2**: Použijte příponu `.mts` pro TypeScript soubory.

---

Další: [Rychlý start](./quick-start.md)
