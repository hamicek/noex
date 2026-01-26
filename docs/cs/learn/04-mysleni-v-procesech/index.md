# Část 4: Myšlení v procesech

Tato sekce vás naučí, jak rozložit problémy na procesy - klíčová mentální změna pro efektivní vývoj s noex.

## Kapitoly

### [4.1 Mapování problémů](./01-mapovani-problemu.md)

Naučte se identifikovat, co by mělo být proces:
- Jeden proces = jedna zodpovědnost
- Stav, který potřebuje izolaci = proces
- Anti-pattern sdíleného stavu

### [4.2 Komunikace mezi procesy](./02-komunikace-mezi-procesy.md)

Komunikační vzory mezi procesy:
- Přímá volání (`call`/`cast`)
- EventBus pro pub/sub
- Registry pro vyhledávání

### [4.3 Vzory](./03-vzory.md)

Běžné vzory pro architektury založené na procesech:
- Request-response pipeline
- Worker pool
- Circuit breaker
- Rate limiting

## Cvičení

Refaktorujte Express middleware na noex procesy.

---

Začněte s: [Mapování problémů](./01-mapovani-problemu.md)
