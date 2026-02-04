<script lang="ts">
  import { onMount } from 'svelte';

  interface Feature {
    key: 'dashboard' | 'tui' | 'metrics' | 'logs';
    title: string;
    description: string;
  }

  interface ObservabilityTranslations {
    title: string;
    subtitle: string;
    features: {
      dashboard: string;
      tui: string;
      metrics: string;
      logs: string;
    };
    descriptions: {
      dashboard: string;
      tui: string;
      metrics: string;
      logs: string;
    };
    badges: {
      realtime: string;
      zeroConfig: string;
      cluster: string;
    };
    command: string;
  }

  interface Props {
    translations: ObservabilityTranslations;
  }

  let { translations }: Props = $props();

  let sectionRef: HTMLElement | null = $state(null);
  let isVisible = $state(false);
  let activeTab = $state<'tui' | 'features'>('tui');
  let tuiTyped = $state(false);
  let featuresVisible = $state([false, false, false, false]);

  const features: Feature[] = $derived([
    { key: 'dashboard', title: translations.features.dashboard, description: translations.descriptions.dashboard },
    { key: 'tui', title: translations.features.tui, description: translations.descriptions.tui },
    { key: 'metrics', title: translations.features.metrics, description: translations.descriptions.metrics },
    { key: 'logs', title: translations.features.logs, description: translations.descriptions.logs }
  ]);

  onMount(() => {
    if (!sectionRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            isVisible = true;
            // Start TUI typing animation
            setTimeout(() => {
              tuiTyped = true;
            }, 600);
            // Stagger feature animations
            featuresVisible.forEach((_, index) => {
              setTimeout(() => {
                featuresVisible[index] = true;
              }, 800 + 150 * index);
            });
          }
        });
      },
      { threshold: 0.15 }
    );

    observer.observe(sectionRef);

    return () => observer.disconnect();
  });

  // TUI Dashboard mockup content - simulates what the actual noex dashboard shows
  const tuiLines = [
    { type: 'header', content: '┌─ Process Tree ────────────────┐ ┌─ Stats Table ─────────────────────────────────────┐' },
    { type: 'tree', content: '│ ▼ supervisor:main             │ │ ID              │ Status  │ Msgs │ Mem    │ Up    │' },
    { type: 'tree', content: '│   ├─ ● counter (running)      │ │─────────────────┼─────────┼──────┼────────┼───────│' },
    { type: 'tree', content: '│   ├─ ● cache (running)        │ │ counter         │ running │ 1.2k │ 2.4 MB │ 01:23 │' },
    { type: 'tree', content: '│   ├─ ● rate-limiter (running) │ │ cache           │ running │ 847  │ 12 MB  │ 01:23 │' },
    { type: 'tree', content: '│   └─ ● event-bus (running)    │ │ rate-limiter    │ running │ 156  │ 1.1 MB │ 01:23 │' },
    { type: 'tree', content: '│                               │ │ event-bus       │ running │ 2.1k │ 3.2 MB │ 01:23 │' },
    { type: 'footer', content: '└───────────────────────────────┘ └───────────────────────────────────────────────────┘' },
    { type: 'gauge', content: '┌─ Memory ──────────────────────┐ ┌─ Event Log ───────────────────────────────────────┐' },
    { type: 'gauge', content: '│ ████████░░░░░                 │ │ [12:34:56] ✓ GenServer started: counter           │' },
    { type: 'gauge', content: '│   67% / 256MB                 │ │ [12:34:57] ✓ GenServer started: cache             │' },
    { type: 'gauge', content: '│                               │ │ [12:34:58] ℹ Supervisor: main (4 children)        │' },
    { type: 'footer', content: '└───────────────────────────────┘ └───────────────────────────────────────────────────┘' },
    { type: 'status', content: ' [q]uit [r]efresh [?]help [1-3]layout │ Processes: 4 │ Up: 00:01:23' }
  ];

  function getLineClass(type: string): string {
    switch (type) {
      case 'header':
      case 'footer':
        return 'tui-border';
      case 'tree':
        return 'tui-tree';
      case 'gauge':
        return 'tui-gauge';
      case 'status':
        return 'tui-status';
      default:
        return '';
    }
  }
</script>

<section
  bind:this={sectionRef}
  id="observability"
  class="observability-section snap-section bg-bg-primary"
  aria-labelledby="observability-title"
>
  <!-- Background elements -->
  <div class="background-elements" aria-hidden="true">
    <div class="gradient-orb gradient-orb-1"></div>
    <div class="gradient-orb gradient-orb-2"></div>
    <div class="grid-pattern"></div>
  </div>

  <div class="content-wrapper max-w-6xl mx-auto relative z-10">
    <!-- Title -->
    <h2
      id="observability-title"
      class="section-title text-3xl md:text-5xl font-bold mb-4 text-text-primary text-center"
      class:visible={isVisible}
    >
      {translations.title}
    </h2>

    <!-- Subtitle -->
    <p
      class="section-subtitle text-lg text-text-secondary text-center mb-10 md:mb-14 max-w-2xl mx-auto"
      class:visible={isVisible}
    >
      {translations.subtitle}
    </p>

    <!-- Main content grid -->
    <div class="observability-grid">
      <!-- TUI Dashboard Mockup -->
      <div class="tui-container" class:visible={isVisible}>
        <div class="tui-window">
          <!-- Window header -->
          <div class="tui-window-header">
            <div class="window-dots">
              <span class="dot dot-red"></span>
              <span class="dot dot-yellow"></span>
              <span class="dot dot-green"></span>
            </div>
            <span class="window-title">noex dashboard — Terminal</span>
            <div class="window-dots invisible">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
            </div>
          </div>

          <!-- TUI Content -->
          <div class="tui-content" class:typed={tuiTyped}>
            {#each tuiLines as line, index}
              <div
                class="tui-line {getLineClass(line.type)}"
                style="animation-delay: {index * 50}ms"
              >
                <code>{@html highlightTuiLine(line.content)}</code>
              </div>
            {/each}

            <!-- Cursor -->
            <div class="tui-cursor" class:blink={tuiTyped}></div>
          </div>
        </div>

        <!-- Command hint -->
        <div class="command-hint" class:visible={tuiTyped}>
          <code class="command">{translations.command}</code>
        </div>
      </div>

      <!-- Features list -->
      <div class="features-container">
        {#each features as feature, index}
          <div
            class="feature-card"
            class:visible={featuresVisible[index]}
            class:accent-primary={index % 2 === 0}
            class:accent-secondary={index % 2 === 1}
          >
            <div class="feature-icon" aria-hidden="true">
              {#if feature.key === 'dashboard'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18" />
                  <path d="M9 21V9" />
                </svg>
              {:else if feature.key === 'tui'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="M6 8l4 4-4 4" />
                  <path d="M12 16h6" />
                </svg>
              {:else if feature.key === 'metrics'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M3 3v18h18" />
                  <path d="M7 16l4-8 4 4 6-8" />
                </svg>
              {:else if feature.key === 'logs'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="M16 13H8" />
                  <path d="M16 17H8" />
                  <path d="M10 9H8" />
                </svg>
              {/if}
            </div>
            <div class="feature-content">
              <h3 class="feature-title">{feature.title}</h3>
              <p class="feature-description">{feature.description}</p>
            </div>
            <div class="feature-glow" aria-hidden="true"></div>
          </div>
        {/each}
      </div>
    </div>

    <!-- Highlight badges -->
    <div class="highlight-badges" class:visible={tuiTyped}>
      <span class="badge badge-primary">{translations.badges.realtime}</span>
      <span class="badge badge-secondary">{translations.badges.zeroConfig}</span>
      <span class="badge badge-primary">{translations.badges.cluster}</span>
    </div>
  </div>
</section>

<script context="module" lang="ts">
  function highlightTuiLine(content: string): string {
    return content
      // Status text - MUST be first, before symbols that create class names with "running"
      .replace(/running/g, '<span class="tui-running">running</span>')
      .replace(/stopped/g, '<span class="tui-stopped">stopped</span>')
      // Status indicators (after text so we don't match "running" in class names)
      .replace(/●/g, '<span class="tui-dot-on">●</span>')
      .replace(/○/g, '<span class="tui-dot-off">○</span>')
      .replace(/▼/g, '<span class="tui-supervisor">▼</span>')
      // Success indicators
      .replace(/✓/g, '<span class="tui-success">✓</span>')
      .replace(/ℹ/g, '<span class="tui-info">ℹ</span>')
      // Keyboard shortcuts
      .replace(/\[([a-z?])\]/g, '<span class="tui-key">[$1]</span>')
      .replace(/\[(\d-\d)\]/g, '<span class="tui-key">[$1]</span>')
      // Numbers and memory - preserve original spacing
      .replace(/(\d+(?:\.\d+)?)(\s?)(MB|k|KB)/g, '<span class="tui-number">$1</span>$2<span class="tui-unit">$3</span>')
      .replace(/(\d{2}:\d{2}:\d{2})/g, '<span class="tui-time">$1</span>')
      // Percentages
      .replace(/(\d+)%/g, '<span class="tui-percent">$1%</span>')
      // Gauge bars
      .replace(/█/g, '<span class="tui-gauge-filled">█</span>')
      .replace(/░/g, '<span class="tui-gauge-empty">░</span>');
  }
</script>

<style>
  .observability-section {
    position: relative;
    overflow: hidden;
  }

  /* Background */
  .background-elements {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .gradient-orb {
    position: absolute;
    border-radius: 50%;
    filter: blur(120px);
    opacity: 0.08;
  }

  .gradient-orb-1 {
    width: 600px;
    height: 600px;
    background: var(--color-accent-primary);
    top: -200px;
    right: -200px;
    animation: orbFloat1 22s ease-in-out infinite;
  }

  .gradient-orb-2 {
    width: 500px;
    height: 500px;
    background: var(--color-accent-secondary);
    bottom: -150px;
    left: -150px;
    animation: orbFloat2 18s ease-in-out infinite;
  }

  .grid-pattern {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(0, 255, 136, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 255, 136, 0.03) 1px, transparent 1px);
    background-size: 40px 40px;
  }

  @keyframes orbFloat1 {
    0%, 100% { transform: translate(0, 0) rotate(0deg); }
    50% { transform: translate(-40px, 40px) rotate(180deg); }
  }

  @keyframes orbFloat2 {
    0%, 100% { transform: translate(0, 0); }
    50% { transform: translate(30px, -30px); }
  }

  /* Title animations */
  .section-title {
    opacity: 0;
    transform: translateY(30px);
    transition: opacity 0.6s ease-out, transform 0.6s ease-out;
  }

  .section-title.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .section-subtitle {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.6s ease-out 0.15s, transform 0.6s ease-out 0.15s;
  }

  .section-subtitle.visible {
    opacity: 1;
    transform: translateY(0);
  }

  /* Grid layout */
  .observability-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 2rem;
  }

  @media (min-width: 1024px) {
    .observability-grid {
      grid-template-columns: 1.4fr 1fr;
      gap: 3rem;
      align-items: start;
    }
  }

  /* TUI Container */
  .tui-container {
    opacity: 0;
    transform: translateY(30px) scale(0.98);
    transition: opacity 0.6s ease-out 0.2s, transform 0.6s ease-out 0.2s;
  }

  .tui-container.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .tui-window {
    background: #0d0d12;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    overflow: hidden;
    box-shadow:
      0 0 60px rgba(0, 255, 136, 0.08),
      0 25px 50px rgba(0, 0, 0, 0.4);
  }

  .tui-window-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid var(--color-border);
  }

  .window-dots {
    display: flex;
    gap: 8px;
  }

  .window-dots.invisible {
    visibility: hidden;
  }

  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--color-border);
  }

  .dot-red { background: #ff5f56; }
  .dot-yellow { background: #ffbd2e; }
  .dot-green { background: #27ca40; }

  .window-title {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    font-family: 'JetBrains Mono', monospace;
  }

  .tui-content {
    padding: 1rem;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.65rem;
    line-height: 1.4;
    overflow-x: auto;
    position: relative;
    min-height: 280px;
  }

  @media (min-width: 768px) {
    .tui-content {
      font-size: 0.7rem;
      padding: 1.25rem;
    }
  }

  .tui-line {
    white-space: pre;
    color: var(--color-text-secondary);
    opacity: 0;
    transform: translateX(-10px);
  }

  .tui-content.typed .tui-line {
    animation: typeIn 0.3s ease-out forwards;
  }

  @keyframes typeIn {
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .tui-border {
    color: var(--color-text-secondary);
  }

  .tui-status {
    background: rgba(0, 255, 136, 0.05);
    margin: 0 -1rem;
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--color-border);
    margin-top: 0.5rem;
  }

  @media (min-width: 768px) {
    .tui-status {
      margin: 0 -1.25rem;
      padding: 0.5rem 1.25rem;
    }
  }

  /* TUI Syntax highlighting */
  .tui-content :global(.tui-dot-on) {
    color: var(--color-accent-primary);
  }

  .tui-content :global(.tui-dot-off) {
    color: var(--color-accent-tertiary);
  }

  .tui-content :global(.tui-supervisor) {
    color: var(--color-accent-secondary);
  }

  .tui-content :global(.tui-running) {
    color: var(--color-accent-primary);
  }

  .tui-content :global(.tui-stopped) {
    color: var(--color-accent-tertiary);
  }

  .tui-content :global(.tui-success) {
    color: var(--color-accent-primary);
  }

  .tui-content :global(.tui-info) {
    color: var(--color-accent-secondary);
  }

  .tui-content :global(.tui-key) {
    color: var(--color-accent-secondary);
  }

  .tui-content :global(.tui-number) {
    color: #b5cea8;
  }

  .tui-content :global(.tui-unit) {
    color: var(--color-text-secondary);
  }

  .tui-content :global(.tui-time) {
    color: var(--color-text-secondary);
  }

  .tui-content :global(.tui-percent) {
    color: var(--color-accent-primary);
  }

  .tui-content :global(.tui-gauge-filled) {
    color: var(--color-accent-primary);
  }

  .tui-content :global(.tui-gauge-empty) {
    color: var(--color-border);
  }

  /* Cursor */
  .tui-cursor {
    display: inline-block;
    width: 8px;
    height: 14px;
    background: var(--color-accent-primary);
    opacity: 0;
    margin-left: 4px;
    vertical-align: middle;
  }

  .tui-cursor.blink {
    opacity: 1;
    animation: blink 1s step-end infinite;
  }

  @keyframes blink {
    50% { opacity: 0; }
  }

  /* Command hint */
  .command-hint {
    margin-top: 1rem;
    text-align: center;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.4s ease-out 0.5s, transform 0.4s ease-out 0.5s;
  }

  .command-hint.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .command {
    display: inline-block;
    padding: 0.5rem 1rem;
    background: rgba(0, 255, 136, 0.1);
    border: 1px solid rgba(0, 255, 136, 0.2);
    border-radius: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    color: var(--color-accent-primary);
  }

  /* Features container */
  .features-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .feature-card {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1.25rem;
    background: rgba(18, 18, 26, 0.6);
    backdrop-filter: blur(12px);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    opacity: 0;
    transform: translateX(30px);
    transition:
      opacity 0.5s ease-out,
      transform 0.5s ease-out,
      border-color 0.3s ease,
      box-shadow 0.3s ease;
    overflow: hidden;
  }

  .feature-card.visible {
    opacity: 1;
    transform: translateX(0);
  }

  .feature-card:hover {
    transform: translateX(-4px);
  }

  .feature-card.accent-primary:hover {
    border-color: var(--color-accent-primary);
    box-shadow: 0 0 30px rgba(0, 255, 136, 0.1);
  }

  .feature-card.accent-secondary:hover {
    border-color: var(--color-accent-secondary);
    box-shadow: 0 0 30px rgba(0, 212, 255, 0.1);
  }

  .feature-icon {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    transition: transform 0.3s ease, background 0.3s ease;
  }

  .feature-icon svg {
    width: 22px;
    height: 22px;
  }

  .accent-primary .feature-icon {
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.15), rgba(0, 255, 136, 0.05));
    color: var(--color-accent-primary);
  }

  .accent-secondary .feature-icon {
    background: linear-gradient(135deg, rgba(0, 212, 255, 0.15), rgba(0, 212, 255, 0.05));
    color: var(--color-accent-secondary);
  }

  .feature-card:hover .feature-icon {
    transform: scale(1.1);
  }

  .feature-content {
    flex: 1;
    min-width: 0;
  }

  .feature-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 0.25rem;
    transition: color 0.3s ease;
  }

  .accent-primary:hover .feature-title {
    color: var(--color-accent-primary);
  }

  .accent-secondary:hover .feature-title {
    color: var(--color-accent-secondary);
  }

  .feature-description {
    font-size: 0.85rem;
    color: var(--color-text-secondary);
    line-height: 1.5;
  }

  .feature-glow {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 60px;
    opacity: 0;
    transition: opacity 0.3s ease;
    pointer-events: none;
  }

  .accent-primary .feature-glow {
    background: linear-gradient(to bottom, rgba(0, 255, 136, 0.06), transparent);
  }

  .accent-secondary .feature-glow {
    background: linear-gradient(to bottom, rgba(0, 212, 255, 0.06), transparent);
  }

  .feature-card:hover .feature-glow {
    opacity: 1;
  }

  /* Highlight badges */
  .highlight-badges {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.75rem;
    margin-top: 2rem;
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease-out 0.8s, transform 0.5s ease-out 0.8s;
  }

  .highlight-badges.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .badge {
    padding: 0.5rem 1rem;
    border-radius: 9999px;
    font-size: 0.8rem;
    font-weight: 500;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }

  .badge:hover {
    transform: translateY(-2px);
  }

  .badge-primary {
    background: rgba(0, 255, 136, 0.1);
    color: var(--color-accent-primary);
    border: 1px solid rgba(0, 255, 136, 0.3);
  }

  .badge-primary:hover {
    box-shadow: 0 4px 20px rgba(0, 255, 136, 0.2);
  }

  .badge-secondary {
    background: rgba(0, 212, 255, 0.1);
    color: var(--color-accent-secondary);
    border: 1px solid rgba(0, 212, 255, 0.3);
  }

  .badge-secondary:hover {
    box-shadow: 0 4px 20px rgba(0, 212, 255, 0.2);
  }

  /* Responsive */
  @media (max-width: 1024px) {
    .tui-container {
      max-width: 100%;
      overflow-x: auto;
    }

    .tui-window {
      min-width: 500px;
    }
  }

  @media (max-width: 768px) {
    .tui-content {
      font-size: 0.55rem;
    }

    .feature-card {
      padding: 1rem;
    }

    .feature-icon {
      width: 36px;
      height: 36px;
    }

    .feature-icon svg {
      width: 20px;
      height: 20px;
    }

    .gradient-orb-1 {
      width: 280px;
      height: 280px;
      opacity: 0.05;
    }

    .gradient-orb-2 {
      width: 220px;
      height: 220px;
      opacity: 0.05;
    }
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .section-title,
    .section-subtitle,
    .tui-container,
    .feature-card,
    .highlight-badges,
    .command-hint {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .tui-line {
      animation: none;
      opacity: 1;
      transform: none;
    }

    .tui-cursor {
      animation: none;
      opacity: 1;
    }

    .gradient-orb-1,
    .gradient-orb-2 {
      animation: none;
    }

    .feature-card:hover,
    .badge:hover {
      transform: none;
    }

    .feature-card:hover .feature-icon {
      transform: none;
    }
  }
</style>
