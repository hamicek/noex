# Koncepty

Tato sekce vysvětluje základní koncepty a vzory za noex. Pochopení těchto základů vám pomůže navrhovat robustní, odolné aplikace.

## Základní vzory

### [GenServer](./genserver.md)
Základní stavební blok pro stavové služby. Naučíte se o:
- Serializaci a frontování zpráv
- Vzorech Call vs Cast
- Behavior callbackech
- Správě životního cyklu

### [Supervisor](./supervisor.md)
Odolnost proti chybám prostřednictvím supervision stromů:
- Restart strategie (one_for_one, one_for_all, rest_for_one)
- Child specifikace
- Limity restart intensity
- Hierarchická supervize

### [Registry](./registry.md)
Pojmenované vyhledávání a discovery procesů:
- Registrace procesů podle jména
- Vyhledávání procesů
- Automatické čištění při ukončení

## Model procesů

### [Životní cyklus](./lifecycle.md)
Pochopení stavů procesů a přechodů:
- Inicializace
- Běžící stav
- Graceful shutdown
- Nucené ukončení

### [Zpracování chyb](./error-handling.md)
Jak noex zpracovává selhání:
- Propagace chyb
- Izolace pádů
- Strategie zotavení
- Vzory defenzivního programování

## Pozadí

### [Porovnání s Elixir](./elixir-comparison.md)
Pro vývojáře obeznámené s Elixir/OTP:
- Mapování Elixir konceptů na TypeScript
- Klíčové rozdíly a omezení
- Migrační vzory

## Rychlý přehled

| Koncept | Účel | Klíčové typy |
|---------|------|--------------|
| GenServer | Stavové procesy | `GenServerBehavior`, `GenServerRef` |
| Supervisor | Odolnost proti chybám | `SupervisorOptions`, `ChildSpec` |
| Registry | Pojmenování procesů | `Registry.register()`, `Registry.lookup()` |

## Další kroky

- Nový v noex? Začněte s [GenServer](./genserver.md)
- Připraveni stavět? Viz [Vytváření služeb](../guides/building-services.md)
- Chcete příklady? Podívejte se na [Příklady](../examples/index.md)
