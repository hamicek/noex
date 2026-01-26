# Část 2: Základy

Tato sekce pokrývá základní stavební bloky noex. Naučíte se vytvářet stavové služby, pochopit jejich životní cyklus a komunikovat s nimi.

## Kapitoly

### [2.1 První GenServer](./01-prvni-genserver.md)

Vytvořte svou první stavovou službu s GenServerem:
- Instalace
- Příklad počítadla
- `init()`, `handleCall()`, `handleCast()`

### [2.2 Životní cyklus procesu](./02-zivotni-cyklus.md)

Pochopte stavy, kterými proces prochází:
- Start → Running → Terminated
- Callback `terminate()`
- Graceful shutdown

### [2.3 Call vs Cast](./03-call-vs-cast.md)

Naučte se, kdy použít který vzor zasílání zpráv:
- `call()` - synchronní s odpovědí
- `cast()` - asynchronní fire-and-forget
- Timeouty a error handling

### [2.4 Registry](./04-registry.md)

Pojmenujte své procesy pro snadné vyhledávání:
- Proč pojmenovávat procesy
- `Registry.whereis()` lookup
- Unique vs duplicate klíče

## Cvičení

Na konci této sekce postavíte key-value store jako GenServer.

---

Začněte s: [První GenServer](./01-prvni-genserver.md)
