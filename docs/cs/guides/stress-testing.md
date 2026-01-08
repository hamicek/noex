# Stress Testování

Tento průvodce vysvětluje, jak spustit stress testy pro noex. Stress testy ověřují chování systému pod vysokou zátěží, chaotickými podmínkami a scénáři selhání.

## Přehled

noex obsahuje dvě kategorie stress testů:

1. **Základní stress testy** - Testují lokální GenServer, Supervisor a utility pod zátěží
2. **Distribuované stress testy** - Testují distribuovaný cluster s reálnými TCP spojeními

---

## Spuštění Stress Testů

### Předpoklady

```bash
npm install
npm run build
```

### Spustit Všechny Stress Testy

```bash
# Všechny stress testy (trvá několik minut)
npm test -- tests/stress/

# S podrobným výstupem
npm test -- tests/stress/ --reporter=verbose
```

### Spustit Pouze Základní Stress Testy

```bash
# Všechny základní stress testy
npm test -- tests/stress/*.test.ts

# Konkrétní testovací soubor
npm test -- tests/stress/supervisor-stress.test.ts
npm test -- tests/stress/chaos-testing.test.ts
npm test -- tests/stress/edge-cases.test.ts
npm test -- tests/stress/utilities.test.ts
```

### Spustit Pouze Distribuované Stress Testy

```bash
# Všechny distribuované stress testy
npm test -- tests/stress/distribution/

# Konkrétní testovací soubor
npm test -- tests/stress/distribution/transport-stress.test.ts
npm test -- tests/stress/distribution/cluster-stress.test.ts
npm test -- tests/stress/distribution/remote-call-stress.test.ts
npm test -- tests/stress/distribution/integration-stress.test.ts
```

### Spustit Konkrétní Test Podle Názvu

```bash
# Spustit testy odpovídající vzoru
npm test -- tests/stress/ -t "high volume"
npm test -- tests/stress/ -t "chaos"
```

---

## Základní Stress Testy

Umístěny v `tests/stress/`:

| Soubor | Popis |
|--------|-------|
| `supervisor-stress.test.ts` | Restart strategie supervisoru, správa potomků pod zátěží |
| `chaos-testing.test.ts` | Náhodné pády, injekce chyb, scénáře obnovy |
| `edge-cases.test.ts` | Hraniční podmínky, race conditions, neobvyklé vstupy |
| `utilities.test.ts` | Testovací utility a pomocné funkce |

### Příklad: Supervisor Stress

```bash
npm test -- tests/stress/supervisor-stress.test.ts --reporter=verbose
```

---

## Distribuované Stress Testy

Umístěny v `tests/stress/distribution/`. Každý testovací soubor používá vyhrazený rozsah portů, aby nedošlo ke konfliktům.

| Soubor | Rozsah portů | Popis |
|--------|--------------|-------|
| `transport-stress.test.ts` | 20000-20099 | TCP transportní vrstva, propustnost zpráv |
| `cluster-stress.test.ts` | 21000-21099 | Formování clusteru, členství nodů |
| `remote-call-stress.test.ts` | 23000-23099 | Vzdálená volání pod zátěží |
| `remote-spawn-stress.test.ts` | 24000-24099 | Vzdálené spouštění procesů |
| `remote-monitor-stress.test.ts` | 25000-25099 | Monitorování procesů napříč nody |
| `global-registry-stress.test.ts` | 26000-26099 | Globální registrace jmen, konflikty |
| `distributed-supervisor-stress.test.ts` | 27000-27099 | Distribuované supervisor strategie |
| `integration-stress.test.ts` | 28000-28099 | Full-stack integrační scénáře |

### Infrastrukturní Testy

| Soubor | Popis |
|--------|-------|
| `cluster-factory.test.ts` | Utility pro správu testovacího clusteru |
| `node-crash-simulator.test.ts` | Utility pro simulaci pádů |
| `distributed-metrics-collector.test.ts` | Sběr metrik |
| `behaviors.test.ts` | Testovací behaviors (counter, echo, atd.) |

### Příklad: Integrační Testy

```bash
npm test -- tests/stress/distribution/integration-stress.test.ts --reporter=verbose
```

**Výstup:**
```
✓ handles task distribution across worker pool with chaos
✓ maintains consistency under concurrent writes
✓ handles sustained load across multiple nodes
✓ survives burst traffic patterns
✓ maintains availability during rolling restart
✓ detects and reports node departures
✓ combines remote spawn, call, and global registry
✓ handles concurrent operations from multiple nodes
```

---

## Doba Trvání Testů

Stress testy trvají déle než unit testy:

| Kategorie | Přibližná doba |
|-----------|----------------|
| Základní stress testy | 30-60 sekund |
| Distribuované stress testy | 2-5 minut |
| Všechny stress testy | 5-10 minut |

Použijte `--reporter=verbose` pro zobrazení průběhu během dlouho běžících testů.

---

## Konfigurace Timeoutu

Některé testy mají prodloužené timeouty (60-120 sekund). Pokud testy vyprší na pomalejších strojích, můžete zvýšit globální timeout:

```bash
npm test -- tests/stress/ --test-timeout=300000
```

---

## Řešení Problémů

### Konflikty Portů

Pokud testy selžou s "address already in use", ujistěte se, že neběží žádné předchozí testovací procesy:

```bash
# Najít procesy používající porty stress testů
lsof -i :20000-28099

# Ukončit osiřelé node procesy
pkill -f "vite-node.*cluster-worker"
```

### Nestabilní Testy

Některé chaos testy mohou občas selhat kvůli timingu. Spusťte znovu jednotlivé selhané testy:

```bash
npm test -- tests/stress/distribution/remote-call-stress.test.ts -t "handles calls to crashing"
```

### Problémy s Pamětí

Pro velké testovací sady zvyšte paměť Node.js:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm test -- tests/stress/
```
