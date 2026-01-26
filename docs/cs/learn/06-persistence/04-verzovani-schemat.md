# Verzování schémat a migrace

Vaše aplikace se vyvíjí. Nové funkce vyžadují nová pole, refaktoring mění tvary dat a aktualizace business logiky vyžadují strukturální změny. Co se ale stane se stavem persistovaným před měsíci, když váš kód očekává úplně jinou strukturu?

Zde přichází na řadu **verzování schémat**. noex sleduje verzi persistovaného stavu a umožňuje vám psát migrační funkce, které upgradují stará data tak, aby odpovídala vašemu aktuálnímu kódu.

## Co se naučíte

- Proč je verzování schémat esenciální pro produkční systémy
- Jak `schemaVersion` sleduje strukturu stavu v čase
- Psaní `migrate()` callbacků pro upgrade stavu
- Inkrementální vs. přímé migrační strategie
- Bezpečné ošetření breaking changes
- Důkladné testování migrací
- Best practices pro dlouhožijící produkční systémy

## Problém: Vyvíjející se stav

Představte si, že jste před rokem vytvořili GenServer pro uživatelské preference:

```typescript
// Verze 1: Původní struktura stavu
interface UserPrefsV1 {
  theme: 'light' | 'dark';
  notifications: boolean;
}
```

Postupem času se vaše požadavky vyvíjely:

```typescript
// Verze 2: Přidán jazyk
interface UserPrefsV2 {
  theme: 'light' | 'dark';
  language: string;         // NOVÉ
  notifications: boolean;
}

// Verze 3: Restrukturované notifikace
interface UserPrefsV3 {
  theme: 'light' | 'dark';
  language: string;
  notifications: {          // ZMĚNĚNO z boolean
    email: boolean;
    push: boolean;
    sms: boolean;
  };
}

// Verze 4: Přidáno přizpůsobení tématu
interface UserPrefsV4 {
  theme: {                  // ZMĚNĚNO z string
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

Když uživatel, který se nepřihlásil rok, otevře vaši aplikaci, jeho persistovaný stav je V1 — ale váš kód očekává V4. Bez migrace vaše aplikace spadne nebo se chová nesprávně.

---

## Jak funguje verzování schémat

noex to řeší dvěma konfiguračními možnostmi:

```typescript
persistence: {
  adapter,
  schemaVersion: 4,                           // Aktuální verze
  migrate: (oldState, oldVersion) => { ... }, // Upgrade funkce
}
```

**Tok:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NAČÍTÁNÍ STAVU S MIGRACÍ                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Načti stav ze storage                                                     │
│           │                                                                 │
│           ▼                                                                 │
│   ┌───────────────────┐                                                     │
│   │ Zkontroluj        │                                                     │
│   │ schemaVersion     │                                                     │
│   │ v metadatech      │                                                     │
│   └─────────┬─────────┘                                                     │
│             │                                                               │
│     ┌───────┴───────┐                                                       │
│     │               │                                                       │
│     ▼               ▼                                                       │
│  Odpovídá        Jiná                                                       │
│  aktuální?       verze                                                      │
│     │               │                                                       │
│     │               ▼                                                       │
│     │     ┌─────────────────┐                                              │
│     │     │ Zavolej migrate()│                                              │
│     │     │ s oldState,      │                                              │
│     │     │ oldVersion       │                                              │
│     │     └────────┬────────┘                                               │
│     │              │                                                        │
│     │              ▼                                                        │
│     │     Migrace uspěla?                                                   │
│     │        │           │                                                  │
│     │      Ano          Ne                                                  │
│     │        │           │                                                  │
│     ▼        ▼           ▼                                                  │
│   Použij stav        MigrationError                                         │
│                     (načtení selhalo)                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Když se stav persistuje, noex ukládá aktuální `schemaVersion` do metadat. Při načítání:

1. noex přečte uloženou verzi z metadat
2. Pokud se liší od aktuální `schemaVersion`, zavolá `migrate()`
3. Migrace vrátí upgradovaný stav (nebo vyhodí chybu při selhání)
4. Upgradovaný stav se použije, jako by byl načten normálně

---

## Možnost schemaVersion

```typescript
persistence: {
  adapter,
  schemaVersion: 1,  // Default je 1 pokud není specifikováno
}
```

**Pravidla:**

- Vždy začněte na verzi 1
- Inkrementujte o 1 pro každou změnu schématu
- Nikdy nepřeskakujte verze (1 → 3 je špatně)
- Nikdy nejděte zpět (3 → 2 je neplatné)
- Verze je uložena v `StateMetadata.schemaVersion`

**Kdy inkrementovat:**

| Typ změny | Inkrementovat verzi? |
|-----------|---------------------|
| Přidání nového volitelného pole | Ne (bezpečné přidat) |
| Přidání nového povinného pole | **Ano** |
| Odstranění pole | **Ano** |
| Přejmenování pole | **Ano** |
| Změna typu pole | **Ano** |
| Restrukturace vnořených objektů | **Ano** |
| Změna enum hodnot | **Ano** |

---

## Psaní migrate funkcí

Callback `migrate()` dostává starý stav a jeho číslo verze a musí vrátit stav kompatibilní s vaším aktuálním kódem.

### Základní migrace

```typescript
interface State {
  userId: string;
  theme: 'light' | 'dark';
  language: string;        // Přidáno ve v2
}

const behavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({
    userId: '',
    theme: 'light',
    language: 'en',
  }),
  // ...handlery
};

await GenServer.start(behavior, {
  name: 'user-prefs',
  persistence: {
    adapter,
    schemaVersion: 2,
    migrate: (oldState, oldVersion) => {
      if (oldVersion === 1) {
        // V1 nemělo pole language
        const v1 = oldState as { userId: string; theme: 'light' | 'dark' };
        return {
          ...v1,
          language: 'en',  // Default hodnota pro nové pole
        };
      }
      // Neznámá verze - vrátit jak je a doufat v nejlepší
      // (nebo vyhodit chybu)
      return oldState as State;
    },
  },
});
```

---

## Migrační strategie

### Strategie 1: Přímá migrace

Každá verze migruje přímo na aktuální verzi:

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
      throw new Error(`Neznámá verze: ${oldVersion}`);
  }
}
```

**Výhody:**
- Nejrychlejší provedení (jediná transformace)
- Jednoduché pro málo verzí

**Nevýhody:**
- Duplicitní logika napříč migracemi
- Musíte aktualizovat všechny migrace při přidání nové verze
- Obtížná údržba s mnoha verzemi

### Strategie 2: Inkrementální migrace (Doporučeno)

Řetězení migrací přes každou verzi sekvenčně:

```typescript
// Definice type-safe migračních funkcí
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
      email: state.notifications,  // Boolean se stává objektem
      push: state.notifications,
      sms: false,
    },
  };
}

function migrateV3ToV4(state: V3State): V4State {
  return {
    ...state,
    theme: {
      mode: state.theme,  // String se stává objektem
      accentColor: '#3b82f6',
    },
  };
}

// Řetězení přes verze
const CURRENT_VERSION = 4;

migrate: (oldState: unknown, oldVersion: number) => {
  let state = oldState;
  let version = oldVersion;

  // Projdi každou verzi až do aktuální
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
        throw new Error(`Žádná migrační cesta z verze ${version}`);
    }
  }

  return state as State;
}
```

**Výhody:**
- Každá migrace je jednoduchá a zaměřená
- Přidání nové verze vyžaduje jen jednu novou funkci
- Snadné testování jednotlivých migrací
- Jasný audit trail

**Nevýhody:**
- Pomalejší pro velmi starý stav (více transformací)
- Musíte udržovat všechny historické migrace

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TOK INKREMENTÁLNÍ MIGRACE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   V1 Stav                                                                   │
│   { theme: 'dark', notifications: true }                                    │
│           │                                                                 │
│           │ migrateV1ToV2                                                   │
│           ▼                                                                 │
│   V2 Stav                                                                   │
│   { theme: 'dark', language: 'en', notifications: true }                    │
│           │                                                                 │
│           │ migrateV2ToV3                                                   │
│           ▼                                                                 │
│   V3 Stav                                                                   │
│   { theme: 'dark', language: 'en',                                          │
│     notifications: { email: true, push: true, sms: false } }                │
│           │                                                                 │
│           │ migrateV3ToV4                                                   │
│           ▼                                                                 │
│   V4 Stav (Aktuální)                                                        │
│   { theme: { mode: 'dark', accentColor: '#3b82f6' },                        │
│     language: 'en',                                                         │
│     notifications: { email: true, push: true, sms: false } }                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Ošetření breaking changes

### Odstranění polí

Při odstraňování pole ho jednoduše nezahrnujte do migrovaného stavu:

```typescript
// V1 mělo pole `legacyId`, které už není potřeba
function migrateV1ToV2(state: V1State): V2State {
  const { legacyId, ...rest } = state;  // Destrukturovat a zahodit
  return rest;
}
```

### Přejmenování polí

```typescript
// V1 používalo `userName`, V2 používá `displayName`
function migrateV1ToV2(state: V1State): V2State {
  const { userName, ...rest } = state;
  return {
    ...rest,
    displayName: userName,  // Kopírovat hodnotu na nové jméno
  };
}
```

### Změna typů polí

```typescript
// V1: items bylo string[], V2: items je Map<string, Item>
function migrateV1ToV2(state: V1State): V2State {
  return {
    ...state,
    items: new Map(
      state.items.map((id, index) => [
        id,
        { id, name: `Položka ${index}`, createdAt: Date.now() },
      ])
    ),
  };
}
```

### Rozdělení polí

```typescript
// V1 mělo `fullName`, V2 má `firstName` a `lastName`
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

### Sloučení polí

```typescript
// V1 mělo samostatná pole, V2 má vnořený objekt
function migrateV1ToV2(state: V1State): V2State {
  const { street, city, zipCode, country, ...rest } = state;
  return {
    ...rest,
    address: { street, city, zipCode, country },
  };
}
```

---

## Validace dat v migracích

Migrace jsou skvělé místo pro validaci a sanitizaci legacy dat:

```typescript
function migrateV1ToV2(state: V1State): V2State {
  // Validovat povinná pole
  if (!state.userId || typeof state.userId !== 'string') {
    throw new Error('Neplatný stav: chybí userId');
  }

  // Sanitizovat potenciálně neplatná data
  const theme = ['light', 'dark'].includes(state.theme)
    ? state.theme
    : 'light';  // Default pro neplatnou hodnotu

  // Omezit numerické hodnoty na platné rozsahy
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

## Migrační chyby

Když migrace selže, noex vyhodí `MigrationError`:

```typescript
import { MigrationError } from '@hamicek/noex';

persistence: {
  adapter,
  schemaVersion: 3,
  migrate: (oldState, oldVersion) => {
    try {
      // Migrační logika
    } catch (error) {
      // Re-throw jako informativní chyba
      throw new Error(
        `Selhala migrace z v${oldVersion}: ${error.message}`
      );
    }
  },
  onError: (error) => {
    if (error instanceof MigrationError) {
      console.error(
        `Migrace selhala: v${error.fromVersion} → v${error.toVersion}`
      );
      console.error('Příčina:', error.cause?.message);

      // Alertovat operations tým
      alerting.critical('state-migration-failed', {
        fromVersion: error.fromVersion,
        toVersion: error.toVersion,
        error: error.cause?.message,
      });
    }
  },
}
```

Když migrace selže:
1. GenServer **nestartuje** s poškozeným stavem
2. Zavolá se `onError` callback s `MigrationError`
3. `init()` se **nevolá** jako fallback (načtení stavu selhalo)
4. Volající kód obdrží chybu a může ji ošetřit

---

## Testování migrací

Migrace jsou kritické code paths — testujte je důkladně:

```typescript
import { describe, test, expect } from 'vitest';

// Exportujte migrační funkce pro testování
export function migrateV1ToV2(state: V1State): V2State { /* ... */ }
export function migrateV2ToV3(state: V2State): V3State { /* ... */ }

describe('State migrace', () => {
  describe('V1 → V2', () => {
    test('přidává default jazyk', () => {
      const v1: V1State = { userId: 'u1', theme: 'dark' };
      const v2 = migrateV1ToV2(v1);

      expect(v2.language).toBe('en');
      expect(v2.theme).toBe('dark');
      expect(v2.userId).toBe('u1');
    });

    test('zachovává všechna existující pole', () => {
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
    test('restrukturuje notifikace', () => {
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

    test('ošetřuje false notifikace', () => {
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

  describe('Plný migrační řetězec', () => {
    test('migruje V1 na aktuální verzi', () => {
      const v1: V1State = { userId: 'u1', theme: 'dark' };

      // Použij skutečnou migrate funkci
      const current = migrate(v1, 1);

      expect(current).toEqual({
        userId: 'u1',
        theme: { mode: 'dark', accentColor: '#3b82f6' },
        language: 'en',
        notifications: { email: true, push: true, sms: false },
      });
    });

    test('ošetřuje již-aktuální stav', () => {
      const current: State = {
        userId: 'u1',
        theme: { mode: 'light', accentColor: '#10b981' },
        language: 'cs',
        notifications: { email: false, push: true, sms: true },
      };

      // Měl by vrátit jak je (žádná migrace potřeba)
      const result = migrate(current, CURRENT_VERSION);
      expect(result).toEqual(current);
    });
  });

  describe('Edge cases', () => {
    test('ošetřuje chybějící volitelná pole', () => {
      const v1 = { userId: 'u1' };  // theme chybí
      const v2 = migrateV1ToV2(v1 as V1State);

      expect(v2.theme).toBe('light');  // Default aplikován
    });

    test('odmítá neplatný stav', () => {
      const invalid = { theme: 'dark' };  // Chybí userId

      expect(() => migrateV1ToV2(invalid as V1State)).toThrow();
    });
  });
});
```

### Integrační testování

Testujte celý tok persistence + migrace:

```typescript
import { GenServer, MemoryAdapter } from '@hamicek/noex';

describe('Persistence s migrací', () => {
  test('migruje stav při obnovení', async () => {
    const adapter = new MemoryAdapter();

    // Simuluj starý stav, který byl persistován
    await adapter.save('user-prefs', {
      state: { userId: 'u1', theme: 'dark' },  // V1 formát
      metadata: {
        persistedAt: Date.now(),
        serverId: 'old-server',
        schemaVersion: 1,
      },
    });

    // Startuj server s aktuálním schématem
    const ref = await GenServer.start(behavior, {
      name: 'user-prefs',
      persistence: {
        adapter,
        schemaVersion: 4,
        migrate,
      },
    });

    // Dotaz pro ověření, že migrace fungovala
    const prefs = await GenServer.call(ref, { type: 'getPreferences' });

    expect(prefs.theme.mode).toBe('dark');
    expect(prefs.language).toBe('en');  // Přidáno migrací
    expect(prefs.notifications.email).toBe(true);  // Restrukturováno

    await GenServer.stop(ref);
  });
});
```

---

## Best practices

### 1. Dokumentace historie verzí

Dokumentujte vaše verze schémat:

```typescript
/**
 * UserPrefs State Schema Historie
 *
 * V1 (úvodní):
 *   - userId: string
 *   - theme: 'light' | 'dark'
 *
 * V2 (2024-03-15):
 *   - Přidáno: language (string, default 'en')
 *
 * V3 (2024-06-01):
 *   - Změněno: notifications z boolean na { email, push, sms }
 *
 * V4 (2024-09-20):
 *   - Změněno: theme z string na { mode, accentColor }
 */
```

### 2. Udržujte migrační funkce čisté

Žádné side effects, žádné async operace:

```typescript
// DOBŘE: Čistá funkce
migrate: (oldState, oldVersion) => {
  return { ...oldState, newField: 'default' };
}

// ŠPATNĚ: Side effects
migrate: async (oldState, oldVersion) => {
  await logMigration(oldVersion);  // Nedělejte toto
  return { ...oldState, newField: 'default' };
}
```

### 3. Default hodnoty pro nová pole

Vždy poskytujte rozumné defaulty:

```typescript
migrate: (oldState, oldVersion) => {
  if (oldVersion === 1) {
    return {
      ...oldState,
      // Explicitní, rozumné defaulty
      language: 'en',
      timezone: 'UTC',
      notifications: { email: true, push: false, sms: false },
    };
  }
  return oldState as State;
}
```

### 4. Zachování neznámých polí (když je to bezpečné)

Spread starý stav pro zachování polí, která explicitně neošetřujete:

```typescript
migrate: (oldState, oldVersion) => {
  const old = oldState as Record<string, unknown>;
  return {
    ...old,  // Zachovat jakákoliv extra pole
    newField: 'value',
  };
}
```

### 5. Rychlé selhání u neznámých verzí

Tiše nepřijímejte verze, které nechápete:

```typescript
migrate: (oldState, oldVersion) => {
  if (oldVersion < 1 || oldVersion >= CURRENT_VERSION) {
    throw new Error(
      `Nelze migrovat z verze ${oldVersion}. ` +
      `Očekáváno 1 až ${CURRENT_VERSION - 1}.`
    );
  }
  // ... migrační logika
}
```

### 6. Zvažte verzi schématu v zálohách

Při obnovování ze záloh záleží na verzi schématu:

```typescript
async function restoreFromBackup(backupPath: string) {
  const backup = await readBackup(backupPath);

  // Zkontroluj, zda je záloha kompatibilní
  if (backup.metadata.schemaVersion > CURRENT_VERSION) {
    throw new Error(
      `Záloha je z novější verze (${backup.metadata.schemaVersion}). ` +
      `Aktuální verze je ${CURRENT_VERSION}. ` +
      `Upgradujte aplikaci před obnovením.`
    );
  }

  // Obnov (migrace proběhne automaticky)
  await adapter.save(key, backup);
}
```

---

## Kompletní příklad: User Settings Service

Zde je production-ready příklad s kompletním verzováním:

```typescript
import { GenServer, GenServerBehavior, SQLiteAdapter } from '@hamicek/noex';

// ============ DEFINICE TYPŮ ============

// Historické typy (pro dokumentaci a migraci)
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

// Aktuální stav (V4)
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

// ============ MIGRAČNÍ FUNKCE ============

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
    throw new Error(`Neplatná verze schématu: ${oldVersion}`);
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
        throw new Error(`Žádná migrační cesta z verze ${version}`);
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
        console.error(`Chyba persistence nastavení pro ${userId}:`, error.message);
      },
    },
  });
}
```

---

## Cvičení: Verzovaný Counter s historií

Vytvořte Counter GenServer s následující evolucí schématu:

**V1:** Jednoduchý counter
```typescript
interface V1 {
  value: number;
}
```

**V2:** Přidáno sledování inkrementů
```typescript
interface V2 {
  value: number;
  totalIncrements: number;
  totalDecrements: number;
}
```

**V3:** Přidána historie (aktuální verze)
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

**Požadavky:**
1. Implementujte migraci z V1 → V2 → V3
2. V1 → V2: Vypočítejte stats z value (předpokládejte, že všechny byly inkrementy)
3. V2 → V3: Restrukturujte stats, inicializujte prázdnou historii
4. Napište testy pro každý migrační krok

### Řešení

```typescript
import { GenServer, GenServerBehavior, MemoryAdapter, MigrationError } from '@hamicek/noex';

// ============ DEFINICE TYPŮ ============

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

// ============ MIGRACE ============

function migrateV1ToV2(state: V1State): V2State {
  // Předpokládej, že aktuální hodnota vznikla z inkrementů od 0
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
    history: [],  // Žádná historická data dostupná
  };
}

function migrate(oldState: unknown, oldVersion: number): CounterState {
  if (oldVersion === CURRENT_VERSION) {
    return oldState as CounterState;
  }

  if (oldVersion < 1 || oldVersion > CURRENT_VERSION) {
    throw new Error(`Nelze migrovat z verze ${oldVersion}`);
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
        throw new Error(`Žádná migrace z verze ${version}`);
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
            ...state.history.slice(-99),  // Zachovat posledních 100 záznamů
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

// ============ TESTY ============

import { describe, test, expect } from 'vitest';

describe('Counter migrace', () => {
  describe('V1 → V2', () => {
    test('kladná hodnota se stává inkrementy', () => {
      const v1: V1State = { value: 5 };
      const v2 = migrateV1ToV2(v1);

      expect(v2.value).toBe(5);
      expect(v2.totalIncrements).toBe(5);
      expect(v2.totalDecrements).toBe(0);
    });

    test('záporná hodnota se stává dekrementy', () => {
      const v1: V1State = { value: -3 };
      const v2 = migrateV1ToV2(v1);

      expect(v2.value).toBe(-3);
      expect(v2.totalIncrements).toBe(0);
      expect(v2.totalDecrements).toBe(3);
    });

    test('nulová hodnota má nulové stats', () => {
      const v1: V1State = { value: 0 };
      const v2 = migrateV1ToV2(v1);

      expect(v2.totalIncrements).toBe(0);
      expect(v2.totalDecrements).toBe(0);
    });
  });

  describe('V2 → V3', () => {
    test('restrukturuje stats', () => {
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

    test('inicializuje prázdnou historii', () => {
      const v2: V2State = { value: 10, totalIncrements: 15, totalDecrements: 5 };
      const v3 = migrateV2ToV3(v2);

      expect(v3.history).toEqual([]);
    });
  });

  describe('Plný řetězec V1 → V3', () => {
    test('migruje kompletně', () => {
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

## Shrnutí

**Klíčové poznatky:**

- **`schemaVersion`** — Integer sledující aktuální strukturu stavu (začněte na 1, inkrementujte o 1)
- **`migrate(oldState, oldVersion)`** — Upgraduje starý stav na aktuální formát
- **Inkrementální migrace** — Řetězte malé migrace (V1→V2→V3→V4) pro udržovatelnost
- **Testujte migrace** — Jsou to kritické code paths, které se dotýkají všech vašich historických dat
- **Rychlé selhání** — Odmítněte neznámé verze místo poškození stavu
- **Dokumentujte změny** — Udržujte changelog verzí schémat

**Migrační checklist:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CHECKLIST MIGRACE SCHÉMATU                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Před deploymentem:                                                         │
│  □ Inkrementovat schemaVersion                                              │
│  □ Napsat migrační funkci pro předchozí verzi                              │
│  □ Otestovat migraci se skutečnými produkčními vzorky dat                  │
│  □ Otestovat plný řetězec od nejstarší po nejnovější verzi                 │
│  □ Aktualizovat dokumentaci verzí schématu                                  │
│                                                                             │
│  Checklist migrační funkce:                                                 │
│  □ Ošetřit všechna pole (přidat nová, odstranit stará, transformovat změněná)│
│  □ Poskytnout rozumné defaulty pro nová pole                               │
│  □ Validovat integritu dat                                                  │
│  □ Udržet funkci čistou (žádné side effects)                               │
│  □ Vyhazovat popisné chyby při selhání                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

Další: [Co je ETS](../../learn/07-ets/01-what-is-ets.md)
