# Část 6: Persistence

Tato sekce pokrývá, jak persistovat stav procesů přes restarty a zotavovat se z pádů.

## Kapitoly

### [6.1 Proč persistence?](./01-proc-persistence.md)

Pochopte potřebu persistence stavu:
- Přežití restartů
- Obnova po pádu
- Snapshoty stavu

### [6.2 Storage adaptery](./02-storage-adaptery.md)

Dostupné storage backendy:
- MemoryAdapter (dev/test)
- FileAdapter (jednoduchý)
- SQLiteAdapter (produkce)

### [6.3 Konfigurace](./03-konfigurace.md)

Konfigurace chování persistence:
- `snapshotIntervalMs`
- `persistOnShutdown`
- `restoreOnStart`

### [6.4 Verzování schémat](./04-verzovani-schemat.md)

Práce s evolucí stavu:
- `schemaVersion`
- `migrate()` callback

## Cvičení

Přidejte persistence k Counter GenServeru.

---

Začněte s: [Proč persistence?](./01-proc-persistence.md)
