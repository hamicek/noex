# Tutoriály

Podrobné návody pro vytváření reálných aplikací s noex.

## Dostupné tutoriály

### [WebSocket Chat Server](./chat-server.md)

Vytvořte real-time chat aplikaci s:
- Správou připojení pomocí GenServerů
- Broadcastingem zpráv pomocí EventBus
- Supervizí pro fault tolerance

**Obtížnost**: Začátečník | **Čas**: 30-45 min

---

### [Rate-Limited API](./rate-limited-api.md)

Vytvořte REST API s throttlingem požadavků:
- Per-user a globální rate limiting
- Standardní rate limit hlavičky
- Odstupňované limity pro různé typy uživatelů

**Obtížnost**: Začátečník | **Čas**: 20-30 min

---

### [E-commerce Backend](./ecommerce-backend.md)

Vytvořte fault-tolerant backend s:
- Supervision stromy pro izolaci služeb
- Inter-service komunikací
- Automatickou obnovou po pádu

**Obtížnost**: Středně pokročilý | **Čas**: 45-60 min

---

### [Monitoring Dashboard](./monitoring-dashboard.md)

Přidejte real-time monitoring do vaší aplikace:
- Observer pro systémovou introspekci
- TUI dashboard s blessed
- Web-based monitoring endpoint
- Konfigurace alertů

**Obtížnost**: Středně pokročilý | **Čas**: 30-45 min

---

## Předpoklady

Všechny tutoriály předpokládají:
- Node.js 18+
- Základní znalost TypeScriptu
- Znalost základů noex (viz [Začínáme](../getting-started/index.md))

## Související

- [Příručky](../guides/index.md) - Podrobné tematické příručky
- [API Reference](../api/index.md) - Kompletní dokumentace API
- [Příklady](../examples/index.md) - Ukázky kódu
