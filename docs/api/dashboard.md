# Dashboard API Reference

The `Dashboard` class provides an interactive TUI (Terminal User Interface) for monitoring noex processes in real-time. Built with `blessed` and `blessed-contrib`, it displays process trees, statistics, memory usage, and event logs.

## Import

```typescript
import { Dashboard } from 'noex/dashboard';
```

## Overview

The Dashboard provides:

- **Process Tree View**: Hierarchical view of supervisors and their children
- **Statistics Table**: Real-time metrics for all GenServers
- **Memory Gauge**: Heap usage visualization
- **Event Log**: Live stream of lifecycle events
- **Multiple Layouts**: Full, compact, and minimal views
- **Keyboard Navigation**: Intuitive controls

## Types

### DashboardConfig

Full configuration for the Dashboard.

```typescript
interface DashboardConfig {
  /**
   * Refresh interval in milliseconds for polling data.
   * @default 500
   */
  readonly refreshInterval: number;

  /**
   * Maximum number of events to keep in the event log.
   * @default 100
   */
  readonly maxEventLogSize: number;

  /**
   * Color theme to use.
   * @default 'dark'
   */
  readonly theme: ThemeName;

  /**
   * Layout mode.
   * @default 'full'
   */
  readonly layout: DashboardLayout;
}
```

### DashboardOptions

Partial configuration for user customization.

```typescript
type DashboardOptions = Partial<DashboardConfig>;
```

### DashboardLayout

Available layout modes.

```typescript
type DashboardLayout = 'full' | 'compact' | 'minimal';
```

- `'full'` - All widgets: process tree, stats table, memory gauge, event log
- `'compact'` - Process tree + stats table only
- `'minimal'` - Stats table only (for small terminals)

### ThemeName

Available color themes.

```typescript
type ThemeName = 'dark' | 'light';
```

### DashboardTheme

Color theme configuration.

```typescript
interface DashboardTheme {
  readonly primary: string;    // Borders and highlights
  readonly secondary: string;  // Less prominent elements
  readonly success: string;    // Running states
  readonly warning: string;    // Warning states
  readonly error: string;      // Error/stopped states
  readonly text: string;       // Default text
  readonly textMuted: string;  // Secondary text
  readonly background: string; // Background color
}
```

---

## Constructor

### new Dashboard()

Creates a new Dashboard instance.

```typescript
constructor(options?: DashboardOptions)
```

**Parameters:**
- `options` - Optional configuration
  - `refreshInterval` - Polling interval in ms (default: 500)
  - `maxEventLogSize` - Max events in log (default: 100)
  - `theme` - Color theme: `'dark'` or `'light'` (default: `'dark'`)
  - `layout` - Layout mode (default: `'full'`)

**Example:**
```typescript
// Default configuration
const dashboard = new Dashboard();

// Custom configuration
const dashboard = new Dashboard({
  refreshInterval: 1000,
  theme: 'light',
  layout: 'compact',
});
```

---

## Methods

### start()

Starts the dashboard and begins rendering.

```typescript
start(): void
```

Creates the terminal screen, sets up widgets, and begins polling for updates.

**Throws:** Error if dashboard is already running

**Example:**
```typescript
const dashboard = new Dashboard();
dashboard.start();
```

---

### stop()

Stops the dashboard and cleans up resources.

```typescript
stop(): void
```

Unsubscribes from events, stops polling, and destroys the terminal screen.

**Example:**
```typescript
dashboard.stop();
```

---

### refresh()

Forces an immediate refresh of all widgets.

```typescript
refresh(): void
```

**Example:**
```typescript
// Manually trigger update
dashboard.refresh();
```

---

### isRunning()

Returns whether the dashboard is currently running.

```typescript
isRunning(): boolean
```

**Returns:** `true` if running

**Example:**
```typescript
if (dashboard.isRunning()) {
  console.log('Dashboard is active');
}
```

---

### switchLayout()

Switches to a different layout mode.

```typescript
switchLayout(layout: DashboardLayout): void
```

**Parameters:**
- `layout` - The layout mode: `'full'`, `'compact'`, or `'minimal'`

**Example:**
```typescript
// Switch to minimal layout
dashboard.switchLayout('minimal');

// Switch back to full layout
dashboard.switchLayout('full');
```

---

### getLayout()

Returns the current layout mode.

```typescript
getLayout(): DashboardLayout
```

**Returns:** Current layout mode

---

### selectProcess()

Programmatically selects a process and shows its detail view.

```typescript
selectProcess(processId: string): void
```

**Parameters:**
- `processId` - ID of the process to select

**Example:**
```typescript
dashboard.selectProcess('genserver_1_abc123');
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `q`, `Escape`, `Ctrl+C` | Quit dashboard |
| `r` | Refresh data |
| `?`, `h` | Show help dialog |
| `Tab` | Focus next widget |
| `Shift+Tab` | Focus previous widget |
| `Enter` | Show process detail view |
| `1` | Switch to full layout |
| `2` | Switch to compact layout |
| `3` | Switch to minimal layout |
| Arrow keys | Navigate within focused widget |

---

## Layouts

### Full Layout

```
+----------------+----------------------------------+
|                |                                  |
|  Process Tree  |          Stats Table             |
|                |                                  |
+----------------+----------------------------------+
|                |                                  |
| Memory Gauge   |          Event Log               |
|                |                                  |
+----------------+----------------------------------+
|              Status Bar                           |
+---------------------------------------------------+
```

### Compact Layout

```
+----------------+----------------------------------+
|                |                                  |
|                |                                  |
|  Process Tree  |          Stats Table             |
|                |                                  |
|                |                                  |
+----------------+----------------------------------+
|              Status Bar                           |
+---------------------------------------------------+
```

### Minimal Layout

```
+---------------------------------------------------+
|                                                   |
|                                                   |
|                   Stats Table                     |
|                                                   |
|                                                   |
+---------------------------------------------------+
|              Status Bar                           |
+---------------------------------------------------+
```

---

## Complete Example

```typescript
import { Dashboard } from 'noex/dashboard';
import { GenServer, Supervisor } from 'noex';

async function main() {
  // Create some processes to monitor
  const workers = await Promise.all([
    GenServer.start({
      init: () => ({ count: 0 }),
      handleCall: (msg, state) => [state.count, state],
      handleCast: (msg, state) => ({ count: state.count + 1 }),
    }, { name: 'worker-1' }),

    GenServer.start({
      init: () => ({ count: 0 }),
      handleCall: (msg, state) => [state.count, state],
      handleCast: (msg, state) => ({ count: state.count + 1 }),
    }, { name: 'worker-2' }),
  ]);

  // Create and start dashboard
  const dashboard = new Dashboard({
    refreshInterval: 500,
    theme: 'dark',
    layout: 'full',
  });

  dashboard.start();

  // Generate some activity
  setInterval(() => {
    for (const worker of workers) {
      GenServer.cast(worker, 'increment');
    }
  }, 100);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    dashboard.stop();
    for (const worker of workers) {
      await GenServer.stop(worker);
    }
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Running the Dashboard

```bash
# Run your application with the dashboard
npx tsx src/main.ts

# Or add a script to package.json
npm run dashboard
```

---

## Tips

1. **Terminal Size**: For best experience, use a terminal at least 120x40 characters
2. **Color Support**: Ensure your terminal supports 256 colors
3. **SSH Sessions**: Works over SSH with proper terminal settings
4. **Screen Readers**: Consider using text logs for accessibility

---

## Related

- [DashboardServer API](./dashboard-server.md) - Remote dashboard access
- [Observer API](./observer.md) - Data source for dashboard
- [AlertManager API](./alert-manager.md) - Alert notifications
