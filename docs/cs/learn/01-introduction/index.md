# Část 1: Úvod

Tato sekce vysvětluje, proč noex existuje, a představuje základní koncepty, které budete používat v celém frameworku.

## Kapitoly

### [1.1 Proč noex?](./01-proc-noex.md)

Dozvíte se o problémech tradičních Node.js aplikací a jak actor model poskytuje elegantní řešení pro:
- Sdílený stav a race conditions
- Komplexitu error handlingu
- Budování odolných systémů

### [1.2 Klíčové koncepty](./02-klicove-koncepty.md)

Přehled základních konceptů:
- **Procesy (GenServer)** - Izolované kontejnery stavu
- **Zprávy (call/cast)** - Jediný způsob komunikace
- **Supervision** - Automatické zotavení z chyb
- **"Let it crash"** - Nový způsob přemýšlení o chybách

## Co se naučíte

Na konci této sekce porozumíte:
- Proč tradiční přístupy selhávají u stavových aplikací
- Co je actor model a proč funguje
- Jak se Erlang/OTP vzory překládají do TypeScriptu
- Filozofii "let it crash"

---

Začněte s: [Proč noex?](./01-proc-noex.md)
