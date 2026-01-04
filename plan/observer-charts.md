# Historické grafy metrik - Implementační plán

## Cíl
Přidat do Observer dashboardu historické grafy zobrazující trendy metrik v čase.

## Architektura

```
┌─────────────────────────────────────────────────────────────┐
│  Observer Dashboard                                          │
├─────────────────────────────────────────────────────────────┤
│  Summary Cards (existující)                                  │
├─────────────────────────────────────────────────────────────┤
│  [NOVÉ] System Metrics Charts                                │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ Throughput  │ │ Proc Count  │ │ Restarts    │            │
│  │ [~~graph~~] │ │ [~~graph~~] │ │ [~~graph~~] │            │
│  └─────────────┘ └─────────────┘ └─────────────┘            │
├─────────────────────────────────────────────────────────────┤
│  Process Tree     │  Process Details                         │
│                   │  [NOVÉ] Per-process chart                │
└─────────────────────────────────────────────────────────────┘
```

## Klíčová rozhodnutí

| Rozhodnutí | Volba | Důvod |
|------------|-------|-------|
| Úložiště dat | Client-side circular buffer | Žádné změny backendu, self-contained |
| Knihovna grafů | Custom canvas rendering | Zero dependencies, ~3KB kódu |
| Délka historie | 15 minut (900 vzorků) | Delší kontext, ~7KB/metrika |
| Polling interval | 1s (existující) | Bez změn backendu |

## Metriky k vizualizaci

### Systémové grafy (vždy viditelné)
1. **Message Throughput** - zprávy za sekundu (delta `totalMessages`)
2. **Active Processes** - počet běžících procesů
3. **Restart Rate** - restarty za sekundu (delta `totalRestarts`)

### Per-process grafy (v detail panelu)
- **GenServer**: Queue Size over time
- **Supervisor**: Restart history

---

## Implementační kroky

### Krok 1: MetricsHistory třída ✅ DONE
Circular buffer pro ukládání time-series dat.

```javascript
class MetricsHistory {
  constructor(capacity = 900) { /* 15 min při 1s intervalu */ }
  push(timestamp, value) { /* O(1) vložení */ }
  getAll() { /* Vrátí seřazené pole */ }
  clear() { /* Reset */ }
}
```

### Krok 2: MetricsStore objekt ✅ DONE
Globální správce všech metrik.

```javascript
const metricsStore = {
  // Systémové
  throughput: new MetricsHistory(900),
  processCount: new MetricsHistory(900),
  restartRate: new MetricsHistory(900),

  // Per-process
  processMetrics: new Map(),

  // Pro výpočet delt
  lastTotalMessages: 0,
  lastTotalRestarts: 0,

  recordSystemMetrics(event) { },
  recordProcessMetrics(id, stats) { },
  clear() { }
};
```

### Krok 3: ChartRenderer objekt ✅ DONE
Minimální canvas-based line chart renderer.

```javascript
const ChartRenderer = {
  colors: {
    throughput: '#22c55e',  // green
    processCount: '#3b82f6', // blue
    restarts: '#eab308',    // yellow
    queueSize: '#a855f7',   // purple
  },

  renderLineChart(canvas, data, options) { },
  drawGrid(ctx, width, height) { },
  drawLine(ctx, points, color) { },
};
```

### Krok 4: CSS pro grafy ✅ DONE
```css
.charts-section { background: var(--bg-secondary); }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.chart-card { background: var(--bg-tertiary); padding: 0.75rem; }
.chart-canvas { width: 100%; height: 120px; }
```

### Krok 5: HTML pro systémové grafy
Přidat za summary cards:
```html
<div class="charts-section">
  <div class="panel-header">System Metrics <span class="badge">Last 15 min</span></div>
  <div class="chart-grid">
    <div class="chart-card">
      <div class="chart-header">Message Throughput (msg/s)</div>
      <canvas id="throughputChart"></canvas>
    </div>
    <!-- + 2 další -->
  </div>
</div>
```

### Krok 6: HTML pro detail chart
Přidat do detail panelu:
```html
<div class="detail-section" id="detailChartSection">
  <h3 id="detailChartTitle">Queue Size History</h3>
  <canvas id="detailChart"></canvas>
</div>
```

### Krok 7: Integrace do handleStatsUpdate
```javascript
function handleStatsUpdate(event) {
  // ... existující kód ...

  // Nové: zaznamenat metriky
  const now = Date.now();
  const msgDelta = totalMessages - metricsStore.lastTotalMessages;
  metricsStore.throughput.push(now, msgDelta);
  metricsStore.processCount.push(now, event.servers.length + event.supervisors.length);
  // ...

  requestAnimationFrame(updateCharts);
}
```

### Krok 8: updateCharts funkce
```javascript
function updateCharts() {
  ChartRenderer.renderLineChart(throughputCanvas, metricsStore.throughput.getAll(), {...});
  ChartRenderer.renderLineChart(processCountCanvas, metricsStore.processCount.getAll(), {...});
  ChartRenderer.renderLineChart(restartRateCanvas, metricsStore.restartRate.getAll(), {...});

  if (selectedId) {
    const history = metricsStore.getProcessHistory(selectedId);
    if (history) {
      ChartRenderer.renderLineChart(detailCanvas, history.queueSize.getAll(), {...});
    }
  }
}
```

---

## Soubory k úpravě

| Soubor | Změna |
|--------|-------|
| `examples/web-server/public/observer/index.html` | Vše - CSS, HTML, JavaScript |

**Žádné změny backendu nejsou potřeba** - využíváme existující WebSocket polling.

---

## Odhad rozsahu

| Komponenta | Řádky kódu |
|------------|------------|
| MetricsHistory | ~30 |
| MetricsStore | ~50 |
| ChartRenderer | ~120 |
| CSS | ~50 |
| HTML | ~35 |
| Integrace | ~60 |
| **Celkem** | **~345** |

---

## Testování

1. Throughput ukazuje správné msg/s
2. Grafy se renderují bez blikání při 1s update
3. Per-process graf se aktualizuje při výběru procesu
4. Reset dat při reconnectu WebSocket
5. Responzivní layout na mobilu
