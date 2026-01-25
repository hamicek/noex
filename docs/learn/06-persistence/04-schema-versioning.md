# Schema Versioning and Migration

Your application evolves. New features require new fields, refactors change data shapes, and business logic updates demand structural changes. But what happens to state persisted months ago when your code expects a completely different structure?

This is where **schema versioning** comes in. noex tracks the version of persisted state and lets you write migration functions that upgrade old data to match your current code.

## What You'll Learn

- Why schema versioning is essential for production systems
- How `schemaVersion` tracks state structure over time
- Writing `migrate()` callbacks for upgrading state
- Incremental vs. direct migration strategies
- Handling breaking changes safely
- Testing migrations thoroughly
- Best practices for long-lived production systems

## The Problem: Evolving State

Imagine you built a user preferences GenServer a year ago:

```typescript
// Version 1: Original state structure
interface UserPrefsV1 {
  theme: 'light' | 'dark';
  notifications: boolean;
}
```

Over time, your requirements evolved:

```typescript
// Version 2: Added language
interface UserPrefsV2 {
  theme: 'light' | 'dark';
  language: string;         // NEW
  notifications: boolean;
}

// Version 3: Restructured notifications
interface UserPrefsV3 {
  theme: 'light' | 'dark';
  language: string;
  notifications: {          // CHANGED from boolean
    email: boolean;
    push: boolean;
    sms: boolean;
  };
}

// Version 4: Added theme customization
interface UserPrefsV4 {
  theme: {                  // CHANGED from string
    mode: 'light' | 'dark';
    accentColor: string;
  };
  language: string;
  notifications: {
    email: boolean;
    push: boolean;
    sms: boolean;
  };
}
```

When a user who hasn't logged in for a year opens your app, their persisted state is V1 — but your code expects V4. Without migration, your app crashes or behaves incorrectly.

---

## How Schema Versioning Works

noex solves this with two configuration options:

```typescript
persistence: {
  adapter,
  schemaVersion: 4,                           // Current version
  migrate: (oldState, oldVersion) => { ... }, // Upgrade function
}
```

**The flow:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         STATE LOADING WITH MIGRATION                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Load state from storage                                                   │
│           │                                                                 │
│           ▼                                                                 │
│   ┌───────────────────┐                                                     │
│   │ Check schemaVersion│                                                    │
│   │ in metadata        │                                                    │
│   └─────────┬─────────┘                                                     │
│             │                                                               │
│     ┌───────┴───────┐                                                       │
│     │               │                                                       │
│     ▼               ▼                                                       │
│  Matches         Different                                                  │
│  current?        version                                                    │
│     │               │                                                       │
│     │               ▼                                                       │
│     │     ┌─────────────────┐                                              │
│     │     │ Call migrate()   │                                              │
│     │     │ with oldState,   │                                              │
│     │     │ oldVersion       │                                              │
│     │     └────────┬────────┘                                               │
│     │              │                                                        │
│     │              ▼                                                        │
│     │     Migration succeeds?                                               │
│     │        │           │                                                  │
│     │      Yes          No                                                  │
│     │        │           │                                                  │
│     ▼        ▼           ▼                                                  │
│   Use state         MigrationError                                          │
│                     (load fails)                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

When state is persisted, noex stores the current `schemaVersion` in metadata. When loading:

1. noex reads the stored version from metadata
2. If it differs from current `schemaVersion`, calls `migrate()`
3. Migration returns upgraded state (or throws on failure)
4. Upgraded state is used as if it was loaded normally

---

## The schemaVersion Option

```typescript
persistence: {
  adapter,
  schemaVersion: 1,  // Default is 1 if not specified
}
```

**Rules:**

- Always start at version 1
- Increment by 1 for each schema change
- Never skip versions (1 → 3 is bad)
- Never go backwards (3 → 2 is invalid)
- Version is stored in `StateMetadata.schemaVersion`

**When to increment:**

| Change Type | Increment Version? |
|-------------|-------------------|
| Add new optional field | No (safe to add) |
| Add new required field | **Yes** |
| Remove a field | **Yes** |
| Rename a field | **Yes** |
| Change field type | **Yes** |
| Restructure nested objects | **Yes** |
| Change enum values | **Yes** |

---

## Writing Migrate Functions

The `migrate()` callback receives the old state and its version number, and must return state compatible with your current code.

### Basic Migration

```typescript
interface State {
  userId: string;
  theme: 'light' | 'dark';
  language: string;        // Added in v2
}

const behavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({
    userId: '',
    theme: 'light',
    language: 'en',
  }),
  // ...handlers
};

await GenServer.start(behavior, {
  name: 'user-prefs',
  persistence: {
    adapter,
    schemaVersion: 2,
    migrate: (oldState, oldVersion) => {
      if (oldVersion === 1) {
        // V1 didn't have language field
        const v1 = oldState as { userId: string; theme: 'light' | 'dark' };
        return {
          ...v1,
          language: 'en',  // Default value for new field
        };
      }
      // Unknown version - return as-is and hope for the best
      // (or throw an error)
      return oldState as State;
    },
  },
});
```

---

## Migration Strategies

### Strategy 1: Direct Migration

Each version migrates directly to current version:

```typescript
migrate: (oldState, oldVersion) => {
  switch (oldVersion) {
    case 1:
      return migrateV1ToCurrent(oldState);
    case 2:
      return migrateV2ToCurrent(oldState);
    case 3:
      return migrateV3ToCurrent(oldState);
    default:
      throw new Error(`Unknown version: ${oldVersion}`);
  }
}
```

**Pros:**
- Fastest execution (single transformation)
- Simple for few versions

**Cons:**
- Duplicated logic across migrations
- Must update all migrations when adding new version
- Hard to maintain with many versions

### Strategy 2: Incremental Migration (Recommended)

Chain migrations through each version sequentially:

```typescript
// Define type-safe migration functions
function migrateV1ToV2(state: V1State): V2State {
  return {
    ...state,
    language: 'en',
  };
}

function migrateV2ToV3(state: V2State): V3State {
  return {
    ...state,
    notifications: {
      email: state.notifications,  // Boolean becomes object
      push: state.notifications,
      sms: false,
    },
  };
}

function migrateV3ToV4(state: V3State): V4State {
  return {
    ...state,
    theme: {
      mode: state.theme,  // String becomes object
      accentColor: '#3b82f6',
    },
  };
}

// Chain through versions
const CURRENT_VERSION = 4;

migrate: (oldState: unknown, oldVersion: number) => {
  let state = oldState;
  let version = oldVersion;

  // Walk through each version until current
  while (version < CURRENT_VERSION) {
    switch (version) {
      case 1:
        state = migrateV1ToV2(state as V1State);
        version = 2;
        break;
      case 2:
        state = migrateV2ToV3(state as V2State);
        version = 3;
        break;
      case 3:
        state = migrateV3ToV4(state as V3State);
        version = 4;
        break;
      default:
        throw new Error(`No migration path from version ${version}`);
    }
  }

  return state as State;
}
```

**Pros:**
- Each migration is simple and focused
- Adding new version only requires one new function
- Easy to test individual migrations
- Clear audit trail

**Cons:**
- Slower for very old state (multiple transformations)
- Must maintain all historical migrations

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       INCREMENTAL MIGRATION FLOW                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   V1 State                                                                  │
│   { theme: 'dark', notifications: true }                                    │
│           │                                                                 │
│           │ migrateV1ToV2                                                   │
│           ▼                                                                 │
│   V2 State                                                                  │
│   { theme: 'dark', language: 'en', notifications: true }                    │
│           │                                                                 │
│           │ migrateV2ToV3                                                   │
│           ▼                                                                 │
│   V3 State                                                                  │
│   { theme: 'dark', language: 'en',                                          │
│     notifications: { email: true, push: true, sms: false } }                │
│           │                                                                 │
│           │ migrateV3ToV4                                                   │
│           ▼                                                                 │
│   V4 State (Current)                                                        │
│   { theme: { mode: 'dark', accentColor: '#3b82f6' },                        │
│     language: 'en',                                                         │
│     notifications: { email: true, push: true, sms: false } }                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Handling Breaking Changes

### Removing Fields

When removing a field, simply don't include it in the migrated state:

```typescript
// V1 had `legacyId` field that's no longer needed
function migrateV1ToV2(state: V1State): V2State {
  const { legacyId, ...rest } = state;  // Destructure and discard
  return rest;
}
```

### Renaming Fields

```typescript
// V1 used `userName`, V2 uses `displayName`
function migrateV1ToV2(state: V1State): V2State {
  const { userName, ...rest } = state;
  return {
    ...rest,
    displayName: userName,  // Copy value to new name
  };
}
```

### Changing Field Types

```typescript
// V1: items was string[], V2: items is Map<string, Item>
function migrateV1ToV2(state: V1State): V2State {
  return {
    ...state,
    items: new Map(
      state.items.map((id, index) => [
        id,
        { id, name: `Item ${index}`, createdAt: Date.now() },
      ])
    ),
  };
}
```

### Splitting Fields

```typescript
// V1 had `fullName`, V2 has `firstName` and `lastName`
function migrateV1ToV2(state: V1State): V2State {
  const [firstName, ...rest] = state.fullName.split(' ');
  const lastName = rest.join(' ') || '';

  const { fullName, ...remaining } = state;
  return {
    ...remaining,
    firstName,
    lastName,
  };
}
```

### Merging Fields

```typescript
// V1 had separate fields, V2 has nested object
function migrateV1ToV2(state: V1State): V2State {
  const { street, city, zipCode, country, ...rest } = state;
  return {
    ...rest,
    address: { street, city, zipCode, country },
  };
}
```

---

## Data Validation in Migrations

Migrations are a great place to validate and sanitize legacy data:

```typescript
function migrateV1ToV2(state: V1State): V2State {
  // Validate required fields
  if (!state.userId || typeof state.userId !== 'string') {
    throw new Error('Invalid state: missing userId');
  }

  // Sanitize potentially invalid data
  const theme = ['light', 'dark'].includes(state.theme)
    ? state.theme
    : 'light';  // Default for invalid value

  // Clamp numeric values to valid ranges
  const retryCount = Math.max(0, Math.min(10, state.retryCount ?? 3));

  return {
    userId: state.userId,
    theme,
    retryCount,
    language: 'en',
  };
}
```

---

## Migration Errors

When migration fails, noex throws a `MigrationError`:

```typescript
import { MigrationError } from '@hamicek/noex';

persistence: {
  adapter,
  schemaVersion: 3,
  migrate: (oldState, oldVersion) => {
    try {
      // Migration logic
    } catch (error) {
      // Re-throw as informative error
      throw new Error(
        `Failed to migrate from v${oldVersion}: ${error.message}`
      );
    }
  },
  onError: (error) => {
    if (error instanceof MigrationError) {
      console.error(
        `Migration failed: v${error.fromVersion} → v${error.toVersion}`
      );
      console.error('Cause:', error.cause?.message);

      // Alert operations team
      alerting.critical('state-migration-failed', {
        fromVersion: error.fromVersion,
        toVersion: error.toVersion,
        error: error.cause?.message,
      });
    }
  },
}
```

When migration fails:
1. The GenServer does **not** start with corrupt state
2. `onError` callback is called with `MigrationError`
3. `init()` is **not** called as fallback (state load fails)
4. The calling code receives the error and can handle it

---

## Testing Migrations

Migrations are critical code paths — test them thoroughly:

```typescript
import { describe, test, expect } from 'vitest';

// Export migration functions for testing
export function migrateV1ToV2(state: V1State): V2State { /* ... */ }
export function migrateV2ToV3(state: V2State): V3State { /* ... */ }

describe('State Migrations', () => {
  describe('V1 → V2', () => {
    test('adds default language', () => {
      const v1: V1State = { userId: 'u1', theme: 'dark' };
      const v2 = migrateV1ToV2(v1);

      expect(v2.language).toBe('en');
      expect(v2.theme).toBe('dark');
      expect(v2.userId).toBe('u1');
    });

    test('preserves all existing fields', () => {
      const v1: V1State = { userId: 'u1', theme: 'light' };
      const v2 = migrateV1ToV2(v1);

      expect(v2).toEqual({
        userId: 'u1',
        theme: 'light',
        language: 'en',
      });
    });
  });

  describe('V2 → V3', () => {
    test('restructures notifications', () => {
      const v2: V2State = {
        userId: 'u1',
        theme: 'dark',
        language: 'en',
        notifications: true,
      };
      const v3 = migrateV2ToV3(v2);

      expect(v3.notifications).toEqual({
        email: true,
        push: true,
        sms: false,
      });
    });

    test('handles false notifications', () => {
      const v2: V2State = {
        userId: 'u1',
        theme: 'dark',
        language: 'en',
        notifications: false,
      };
      const v3 = migrateV2ToV3(v2);

      expect(v3.notifications).toEqual({
        email: false,
        push: false,
        sms: false,
      });
    });
  });

  describe('Full migration chain', () => {
    test('migrates V1 to current version', () => {
      const v1: V1State = { userId: 'u1', theme: 'dark' };

      // Use the actual migrate function
      const current = migrate(v1, 1);

      expect(current).toEqual({
        userId: 'u1',
        theme: { mode: 'dark', accentColor: '#3b82f6' },
        language: 'en',
        notifications: { email: true, push: true, sms: false },
      });
    });

    test('handles already-current state', () => {
      const current: State = {
        userId: 'u1',
        theme: { mode: 'light', accentColor: '#10b981' },
        language: 'cs',
        notifications: { email: false, push: true, sms: true },
      };

      // Should return as-is (no migration needed)
      const result = migrate(current, CURRENT_VERSION);
      expect(result).toEqual(current);
    });
  });

  describe('Edge cases', () => {
    test('handles missing optional fields', () => {
      const v1 = { userId: 'u1' };  // theme is missing
      const v2 = migrateV1ToV2(v1 as V1State);

      expect(v2.theme).toBe('light');  // Default applied
    });

    test('rejects invalid state', () => {
      const invalid = { theme: 'dark' };  // Missing userId

      expect(() => migrateV1ToV2(invalid as V1State)).toThrow();
    });
  });
});
```

### Integration Testing

Test the full persistence + migration flow:

```typescript
import { GenServer, MemoryAdapter } from '@hamicek/noex';

describe('Persistence with Migration', () => {
  test('migrates state on restore', async () => {
    const adapter = new MemoryAdapter();

    // Simulate old state being persisted
    await adapter.save('user-prefs', {
      state: { userId: 'u1', theme: 'dark' },  // V1 format
      metadata: {
        persistedAt: Date.now(),
        serverId: 'old-server',
        schemaVersion: 1,
      },
    });

    // Start server with current schema
    const ref = await GenServer.start(behavior, {
      name: 'user-prefs',
      persistence: {
        adapter,
        schemaVersion: 4,
        migrate,
      },
    });

    // Query to verify migration worked
    const prefs = await GenServer.call(ref, { type: 'getPreferences' });

    expect(prefs.theme.mode).toBe('dark');
    expect(prefs.language).toBe('en');  // Added by migration
    expect(prefs.notifications.email).toBe(true);  // Restructured

    await GenServer.stop(ref);
  });
});
```

---

## Best Practices

### 1. Version History Documentation

Document your schema versions:

```typescript
/**
 * UserPrefs State Schema History
 *
 * V1 (initial):
 *   - userId: string
 *   - theme: 'light' | 'dark'
 *
 * V2 (2024-03-15):
 *   - Added: language (string, default 'en')
 *
 * V3 (2024-06-01):
 *   - Changed: notifications from boolean to { email, push, sms }
 *
 * V4 (2024-09-20):
 *   - Changed: theme from string to { mode, accentColor }
 */
```

### 2. Keep Migration Functions Pure

No side effects, no async operations:

```typescript
// GOOD: Pure function
migrate: (oldState, oldVersion) => {
  return { ...oldState, newField: 'default' };
}

// BAD: Side effects
migrate: async (oldState, oldVersion) => {
  await logMigration(oldVersion);  // Don't do this
  return { ...oldState, newField: 'default' };
}
```

### 3. Default Values for New Fields

Always provide sensible defaults:

```typescript
migrate: (oldState, oldVersion) => {
  if (oldVersion === 1) {
    return {
      ...oldState,
      // Explicit, sensible defaults
      language: 'en',
      timezone: 'UTC',
      notifications: { email: true, push: false, sms: false },
    };
  }
  return oldState as State;
}
```

### 4. Preserve Unknown Fields (When Safe)

Spread the old state to keep fields you're not explicitly handling:

```typescript
migrate: (oldState, oldVersion) => {
  const old = oldState as Record<string, unknown>;
  return {
    ...old,  // Preserve any extra fields
    newField: 'value',
  };
}
```

### 5. Fail Fast on Unknown Versions

Don't silently accept versions you don't understand:

```typescript
migrate: (oldState, oldVersion) => {
  if (oldVersion < 1 || oldVersion >= CURRENT_VERSION) {
    throw new Error(
      `Cannot migrate from version ${oldVersion}. ` +
      `Expected 1 to ${CURRENT_VERSION - 1}.`
    );
  }
  // ... migration logic
}
```

### 6. Consider Schema Version in Backups

When restoring from backups, schema version matters:

```typescript
async function restoreFromBackup(backupPath: string) {
  const backup = await readBackup(backupPath);

  // Check if backup is compatible
  if (backup.metadata.schemaVersion > CURRENT_VERSION) {
    throw new Error(
      `Backup is from a newer version (${backup.metadata.schemaVersion}). ` +
      `Current version is ${CURRENT_VERSION}. ` +
      `Upgrade your application before restoring.`
    );
  }

  // Restore (migration will happen automatically)
  await adapter.save(key, backup);
}
```

---

## Complete Example: User Settings Service

Here's a production-ready example with full versioning:

```typescript
import { GenServer, GenServerBehavior, SQLiteAdapter } from '@hamicek/noex';

// ============ TYPE DEFINITIONS ============

// Historical types (for documentation and migration)
interface V1State {
  userId: string;
  darkMode: boolean;
}

interface V2State {
  userId: string;
  theme: 'light' | 'dark' | 'system';
  language: string;
}

interface V3State {
  userId: string;
  theme: 'light' | 'dark' | 'system';
  language: string;
  accessibility: {
    reduceMotion: boolean;
    highContrast: boolean;
  };
}

// Current state (V4)
interface UserSettingsState {
  userId: string;
  theme: 'light' | 'dark' | 'system';
  language: string;
  accessibility: {
    reduceMotion: boolean;
    highContrast: boolean;
    fontSize: 'small' | 'medium' | 'large';
  };
  lastModified: number;
}

const CURRENT_VERSION = 4;

// ============ MIGRATION FUNCTIONS ============

function migrateV1ToV2(state: V1State): V2State {
  return {
    userId: state.userId,
    theme: state.darkMode ? 'dark' : 'light',
    language: 'en',
  };
}

function migrateV2ToV3(state: V2State): V3State {
  return {
    ...state,
    accessibility: {
      reduceMotion: false,
      highContrast: false,
    },
  };
}

function migrateV3ToV4(state: V3State): UserSettingsState {
  return {
    ...state,
    accessibility: {
      ...state.accessibility,
      fontSize: 'medium',
    },
    lastModified: Date.now(),
  };
}

function migrate(oldState: unknown, oldVersion: number): UserSettingsState {
  if (oldVersion === CURRENT_VERSION) {
    return oldState as UserSettingsState;
  }

  if (oldVersion < 1 || oldVersion > CURRENT_VERSION) {
    throw new Error(`Invalid schema version: ${oldVersion}`);
  }

  let state = oldState;
  let version = oldVersion;

  while (version < CURRENT_VERSION) {
    switch (version) {
      case 1:
        state = migrateV1ToV2(state as V1State);
        version = 2;
        break;
      case 2:
        state = migrateV2ToV3(state as V2State);
        version = 3;
        break;
      case 3:
        state = migrateV3ToV4(state as V3State);
        version = 4;
        break;
      default:
        throw new Error(`No migration path from version ${version}`);
    }
  }

  return state as UserSettingsState;
}

// ============ GENSERVER BEHAVIOR ============

type Call =
  | { type: 'get' }
  | { type: 'getTheme' }
  | { type: 'getAccessibility' };

type Cast =
  | { type: 'setTheme'; theme: UserSettingsState['theme'] }
  | { type: 'setLanguage'; language: string }
  | { type: 'setAccessibility'; settings: Partial<UserSettingsState['accessibility']> };

type Reply = UserSettingsState | UserSettingsState['theme'] | UserSettingsState['accessibility'];

const userSettingsBehavior: GenServerBehavior<UserSettingsState, Call, Cast, Reply> = {
  init: () => ({
    userId: '',
    theme: 'system',
    language: 'en',
    accessibility: {
      reduceMotion: false,
      highContrast: false,
      fontSize: 'medium',
    },
    lastModified: Date.now(),
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state, state];
      case 'getTheme':
        return [state.theme, state];
      case 'getAccessibility':
        return [state.accessibility, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'setTheme':
        return { ...state, theme: msg.theme, lastModified: Date.now() };
      case 'setLanguage':
        return { ...state, language: msg.language, lastModified: Date.now() };
      case 'setAccessibility':
        return {
          ...state,
          accessibility: { ...state.accessibility, ...msg.settings },
          lastModified: Date.now(),
        };
    }
  },
};

// ============ START SERVER ============

const adapter = new SQLiteAdapter({ filename: './data/settings.db' });

async function createUserSettings(userId: string) {
  return GenServer.start(userSettingsBehavior, {
    name: `settings-${userId}`,
    persistence: {
      adapter,
      key: `user:${userId}:settings`,
      schemaVersion: CURRENT_VERSION,
      migrate,
      snapshotIntervalMs: 60000,
      persistOnShutdown: true,
      restoreOnStart: true,
      onError: (error) => {
        console.error(`Settings persistence error for ${userId}:`, error.message);
      },
    },
  });
}
```

---

## Exercise: Versioned Counter with History

Create a Counter GenServer with the following schema evolution:

**V1:** Simple counter
```typescript
interface V1 {
  value: number;
}
```

**V2:** Added increment tracking
```typescript
interface V2 {
  value: number;
  totalIncrements: number;
  totalDecrements: number;
}
```

**V3:** Added history (current version)
```typescript
interface V3 {
  value: number;
  stats: {
    totalIncrements: number;
    totalDecrements: number;
    lastModified: number;
  };
  history: Array<{
    action: 'increment' | 'decrement' | 'reset';
    timestamp: number;
    previousValue: number;
  }>;
}
```

**Requirements:**
1. Implement migration from V1 → V2 → V3
2. V1 → V2: Calculate stats from value (assume all were increments)
3. V2 → V3: Restructure stats, initialize empty history
4. Write tests for each migration step

### Solution

```typescript
import { GenServer, GenServerBehavior, MemoryAdapter, MigrationError } from '@hamicek/noex';

// ============ TYPE DEFINITIONS ============

interface V1State {
  value: number;
}

interface V2State {
  value: number;
  totalIncrements: number;
  totalDecrements: number;
}

interface CounterState {
  value: number;
  stats: {
    totalIncrements: number;
    totalDecrements: number;
    lastModified: number;
  };
  history: Array<{
    action: 'increment' | 'decrement' | 'reset';
    timestamp: number;
    previousValue: number;
  }>;
}

const CURRENT_VERSION = 3;

// ============ MIGRATIONS ============

function migrateV1ToV2(state: V1State): V2State {
  // Assume current value came from increments starting at 0
  const increments = Math.max(0, state.value);
  const decrements = Math.max(0, -state.value);

  return {
    value: state.value,
    totalIncrements: increments,
    totalDecrements: decrements,
  };
}

function migrateV2ToV3(state: V2State): CounterState {
  return {
    value: state.value,
    stats: {
      totalIncrements: state.totalIncrements,
      totalDecrements: state.totalDecrements,
      lastModified: Date.now(),
    },
    history: [],  // No historical data available
  };
}

function migrate(oldState: unknown, oldVersion: number): CounterState {
  if (oldVersion === CURRENT_VERSION) {
    return oldState as CounterState;
  }

  if (oldVersion < 1 || oldVersion > CURRENT_VERSION) {
    throw new Error(`Cannot migrate from version ${oldVersion}`);
  }

  let state = oldState;
  let version = oldVersion;

  while (version < CURRENT_VERSION) {
    switch (version) {
      case 1:
        state = migrateV1ToV2(state as V1State);
        version = 2;
        break;
      case 2:
        state = migrateV2ToV3(state as V2State);
        version = 3;
        break;
      default:
        throw new Error(`No migration from version ${version}`);
    }
  }

  return state as CounterState;
}

// ============ GENSERVER ============

type Call = { type: 'get' } | { type: 'getHistory' };
type Cast =
  | { type: 'increment' }
  | { type: 'decrement' }
  | { type: 'reset' };
type Reply = CounterState | CounterState['history'];

const counterBehavior: GenServerBehavior<CounterState, Call, Cast, Reply> = {
  init: () => ({
    value: 0,
    stats: {
      totalIncrements: 0,
      totalDecrements: 0,
      lastModified: Date.now(),
    },
    history: [],
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state, state];
      case 'getHistory':
        return [state.history, state];
    }
  },

  handleCast: (msg, state) => {
    const timestamp = Date.now();
    const previousValue = state.value;

    switch (msg.type) {
      case 'increment':
        return {
          value: state.value + 1,
          stats: {
            ...state.stats,
            totalIncrements: state.stats.totalIncrements + 1,
            lastModified: timestamp,
          },
          history: [
            ...state.history.slice(-99),  // Keep last 100 entries
            { action: 'increment', timestamp, previousValue },
          ],
        };

      case 'decrement':
        return {
          value: state.value - 1,
          stats: {
            ...state.stats,
            totalDecrements: state.stats.totalDecrements + 1,
            lastModified: timestamp,
          },
          history: [
            ...state.history.slice(-99),
            { action: 'decrement', timestamp, previousValue },
          ],
        };

      case 'reset':
        return {
          value: 0,
          stats: {
            ...state.stats,
            lastModified: timestamp,
          },
          history: [
            ...state.history.slice(-99),
            { action: 'reset', timestamp, previousValue },
          ],
        };
    }
  },
};

// ============ TESTS ============

import { describe, test, expect } from 'vitest';

describe('Counter Migrations', () => {
  describe('V1 → V2', () => {
    test('positive value becomes increments', () => {
      const v1: V1State = { value: 5 };
      const v2 = migrateV1ToV2(v1);

      expect(v2.value).toBe(5);
      expect(v2.totalIncrements).toBe(5);
      expect(v2.totalDecrements).toBe(0);
    });

    test('negative value becomes decrements', () => {
      const v1: V1State = { value: -3 };
      const v2 = migrateV1ToV2(v1);

      expect(v2.value).toBe(-3);
      expect(v2.totalIncrements).toBe(0);
      expect(v2.totalDecrements).toBe(3);
    });

    test('zero value has zero stats', () => {
      const v1: V1State = { value: 0 };
      const v2 = migrateV1ToV2(v1);

      expect(v2.totalIncrements).toBe(0);
      expect(v2.totalDecrements).toBe(0);
    });
  });

  describe('V2 → V3', () => {
    test('restructures stats', () => {
      const v2: V2State = {
        value: 10,
        totalIncrements: 15,
        totalDecrements: 5,
      };
      const v3 = migrateV2ToV3(v2);

      expect(v3.stats.totalIncrements).toBe(15);
      expect(v3.stats.totalDecrements).toBe(5);
      expect(v3.stats.lastModified).toBeGreaterThan(0);
    });

    test('initializes empty history', () => {
      const v2: V2State = { value: 10, totalIncrements: 15, totalDecrements: 5 };
      const v3 = migrateV2ToV3(v2);

      expect(v3.history).toEqual([]);
    });
  });

  describe('Full chain V1 → V3', () => {
    test('migrates completely', () => {
      const v1: V1State = { value: 7 };
      const v3 = migrate(v1, 1);

      expect(v3.value).toBe(7);
      expect(v3.stats.totalIncrements).toBe(7);
      expect(v3.stats.totalDecrements).toBe(0);
      expect(v3.history).toEqual([]);
    });
  });
});
```

---

## Summary

**Key takeaways:**

- **`schemaVersion`** — Integer tracking current state structure (start at 1, increment by 1)
- **`migrate(oldState, oldVersion)`** — Upgrades old state to current format
- **Incremental migration** — Chain small migrations (V1→V2→V3→V4) for maintainability
- **Test migrations** — They're critical code paths that touch all your historical data
- **Fail fast** — Reject unknown versions rather than corrupting state
- **Document changes** — Keep a changelog of schema versions

**Migration checklist:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SCHEMA MIGRATION CHECKLIST                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Before deploying:                                                          │
│  □ Increment schemaVersion                                                  │
│  □ Write migration function for previous version                            │
│  □ Test migration with real production data samples                         │
│  □ Test full chain from oldest to newest version                            │
│  □ Update schema version documentation                                       │
│                                                                             │
│  Migration function checklist:                                              │
│  □ Handle all fields (add new, remove old, transform changed)               │
│  □ Provide sensible defaults for new fields                                 │
│  □ Validate data integrity                                                  │
│  □ Keep function pure (no side effects)                                     │
│  □ Throw descriptive errors on failure                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

Next: [What is ETS](../07-ets/01-what-is-ets.md)
