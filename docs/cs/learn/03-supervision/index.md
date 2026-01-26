# Část 3: Supervision

Tato sekce vás naučí, jak vytvářet fault-tolerantní aplikace pomocí Supervisorů. Naučíte se přijmout selhání jako normální součást provozu a nechat systém automaticky se zotavit.

## Kapitoly

### [3.1 Proč Supervisor?](./01-proc-supervisor.md)

Pochopte potřebu automatického zotavení:
- Procesy selhávají - to je normální
- Automatický restart vs manuální error handling
- Izolace - jedno selhání neovlivní ostatní

### [3.2 První Supervisor](./02-prvni-supervisor.md)

Vytvořte svou první supervizovanou aplikaci:
- Vytvoření supervisoru s dětmi
- Child specs (`id`, `start`, `restart`)
- Sledování restartů

### [3.3 Restart strategie](./03-restart-strategie.md)

Naučte se tři restart strategie:
- `one_for_one` - restart pouze selhané
- `one_for_all` - restart všech (závislé služby)
- `rest_for_one` - restart selhané + následující

### [3.4 Restart intenzita](./04-restart-intenzita.md)

Prevence restart smyček:
- `maxRestarts` a `withinMs`
- Kdy supervisor vzdá a zastaví se

### [3.5 Stromy supervize](./05-stromy-supervize.md)

Budujte hierarchickou izolaci selhání:
- Hierarchie supervisorů
- Izolace failure domains
- Praktické příklady struktur

## Cvičení

Navrhněte strom supervize pro chatovací aplikaci.

---

Začněte s: [Proč Supervisor?](./01-proc-supervisor.md)
