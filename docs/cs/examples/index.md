# Příklady

Okomentované příklady kódu demonstrující vzory a best practices knihovny noex.

## Základní příklady

### [Základní počítadlo](./basic-counter.md)

Minimální příklad GenServeru ukazující základní koncepty:
- Správa stavu
- Synchronní volání a asynchronní casty
- Lifecycle hooky

**Složitost**: Jednoduchá | **Řádky**: ~50

---

### [Cache služba](./cache-service.md)

Key-value cache s podporou TTL:
- Použití vestavěné Cache služby
- Expirace a eviction politiky
- Sledování statistik

**Složitost**: Jednoduchá | **Řádky**: ~40

---

## Středně pokročilé příklady

### [Worker Pool](./worker-pool.md)

Dynamický pool workerů pro paralelní zpracování:
- DynamicSupervisor vzor
- Distribuce práce
- Load balancing

**Složitost**: Středně pokročilá | **Řádky**: ~100

---

### [Web Server](./web-server.md)

WebSocket chat server se správou připojení:
- Per-connection GenServery
- Integrace s EventBus
- Vzory pro broadcasting

**Složitost**: Středně pokročilá | **Řádky**: ~150

---

## Pokročilé příklady

### [Supervision Tree](./supervision-tree.md)

Vícevrstvá aplikace se supervizí:
- Vnořené supervisory
- Izolace služeb
- Strategie obnovy

**Složitost**: Pokročilá | **Řádky**: ~200

---

## Spuštění příkladů

Všechny příklady lze spustit přímo pomocí tsx:

```bash
npx tsx example.ts
```

Nebo zkompilovat TypeScriptem a spustit:

```bash
tsc example.ts
node example.js
```

## Související

- [Rychlý start](../getting-started/quick-start.md) - Začněte s noex
- [Tutoriály](../tutorials/index.md) - Průvodci krok za krokem
- [API Reference](../api/index.md) - Kompletní API dokumentace
