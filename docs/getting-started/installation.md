# Installation

## Requirements

- **Node.js**: 20.0.0 or later
- **TypeScript**: 5.0+ (recommended, but not required)

## Package Installation

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

## TypeScript Configuration

noex is written in TypeScript and ships with type definitions. For the best experience, ensure your `tsconfig.json` includes:

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

## Optional Dependencies

### Dashboard (TUI)

The built-in terminal dashboard requires `blessed` and `blessed-contrib`:

```bash
npm install blessed blessed-contrib
```

Without these packages, the core library works fine, but the Dashboard features won't be available.

## Verify Installation

Create a simple test file to verify everything works:

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
console.log('noex is working!');
```

Run it:

```bash
npx tsx test.ts
```

If you see "noex is working!", you're all set!

## Project Structure

A typical noex project might look like:

```
my-app/
├── src/
│   ├── services/          # Your GenServer implementations
│   │   ├── user-service.ts
│   │   └── cache-service.ts
│   ├── supervisors/       # Supervisor configurations
│   │   └── app-supervisor.ts
│   └── index.ts           # Application entry point
├── package.json
└── tsconfig.json
```

## ESM vs CommonJS

noex is distributed as ESM (ECMAScript Modules). Ensure your project is configured for ESM:

**Option 1**: Set `"type": "module"` in `package.json`:

```json
{
  "type": "module"
}
```

**Option 2**: Use `.mts` file extension for TypeScript files.

---

Next: [Quick Start](./quick-start.md)
