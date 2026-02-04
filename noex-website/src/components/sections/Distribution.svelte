<script lang="ts">

  interface DistributionTranslations {
    title: string;
    subtitle: string;
    features: {
      cluster: string;
      global: string;
      transparent: string;
    };
    descriptions: {
      cluster: string;
      global: string;
      transparent: string;
    };
    nodeLabels: {
      local: string;
      remote: string;
    };
    badges: {
      autoDiscovery: string;
      noSinglePoint: string;
      seamless: string;
    };
    codeHint: string;
  }

  interface Props {
    translations: DistributionTranslations;
  }

  let { translations }: Props = $props();

  let sectionRef: HTMLElement | null = $state(null);
  let isVisible = $state(false);
  let nodesVisible = $state(false);
  let connectionsActive = $state(false);
  let featuresVisible = $state([false, false, false]);
  let codeVisible = $state(false);

  $effect(() => {
    if (!sectionRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            isVisible = true;
            // Start node animations
            setTimeout(() => {
              nodesVisible = true;
            }, 300);
            // Activate connections
            setTimeout(() => {
              connectionsActive = true;
            }, 800);
            // Stagger feature cards
            featuresVisible.forEach((_, index) => {
              setTimeout(() => {
                featuresVisible[index] = true;
              }, 1000 + 150 * index);
            });
            // Show code block
            setTimeout(() => {
              codeVisible = true;
            }, 1500);
          }
        });
      },
      { threshold: 0.15 }
    );

    observer.observe(sectionRef);

    return () => observer.disconnect();
  });

  // Node positions for the cluster visualization (percentage based)
  const nodes = [
    { id: 'local', x: 50, y: 50, isLocal: true },
    { id: 'node1', x: 20, y: 25, isLocal: false },
    { id: 'node2', x: 80, y: 25, isLocal: false },
    { id: 'node3', x: 15, y: 70, isLocal: false },
    { id: 'node4', x: 85, y: 70, isLocal: false },
    { id: 'node5', x: 50, y: 90, isLocal: false }
  ];

  // Generate connections from local to all remote nodes
  const connections = nodes
    .filter((n) => !n.isLocal)
    .map((node) => ({
      from: { x: 50, y: 50 },
      to: { x: node.x, y: node.y },
      id: `conn-${node.id}`
    }));

  // Feature data
  const features = $derived([
    {
      key: 'cluster' as const,
      icon: 'cluster',
      title: translations.features.cluster,
      description: translations.descriptions.cluster,
      accent: 'primary'
    },
    {
      key: 'global' as const,
      icon: 'global',
      title: translations.features.global,
      description: translations.descriptions.global,
      accent: 'secondary'
    },
    {
      key: 'transparent' as const,
      icon: 'transparent',
      title: translations.features.transparent,
      description: translations.descriptions.transparent,
      accent: 'primary'
    }
  ]);

  // Code example
  const codeSnippet = `// Register a process globally
await GlobalRegistry.register('user:session:123', pid);

// Find it from any node in the cluster
const pid = await GlobalRegistry.whereis('user:session:123');

// Send a message - works across nodes
await GenServer.call(pid, { type: 'get_data' });`;
</script>

<section
  bind:this={sectionRef}
  id="distribution"
  class="distribution-section snap-section bg-bg-secondary"
  aria-labelledby="distribution-title"
>
  <!-- Background elements -->
  <div class="background-elements" aria-hidden="true">
    <div class="gradient-orb gradient-orb-1"></div>
    <div class="gradient-orb gradient-orb-2"></div>
    <div class="hex-pattern"></div>
  </div>

  <div class="content-wrapper max-w-6xl mx-auto relative z-10">
    <!-- Title -->
    <h2
      id="distribution-title"
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
    <div class="distribution-grid">
      <!-- Cluster visualization -->
      <div class="cluster-container" class:visible={isVisible}>
        <div class="cluster-visualization">
          <svg
            viewBox="0 0 100 100"
            class="cluster-svg"
            aria-label="P2P cluster visualization showing connected nodes"
            role="img"
          >
            <!-- Connection lines -->
            {#each connections as conn, i}
              <g class="connection-group" class:active={connectionsActive}>
                <!-- Base line -->
                <line
                  x1={conn.from.x}
                  y1={conn.from.y}
                  x2={conn.to.x}
                  y2={conn.to.y}
                  class="connection-line"
                  style="animation-delay: {i * 0.15}s"
                />
                <!-- Animated data packet -->
                <circle class="data-packet" r="1.2" style="animation-delay: {i * 0.3}s">
                  <animateMotion
                    dur="2s"
                    repeatCount="indefinite"
                    begin="{i * 0.3}s"
                    path="M {conn.from.x},{conn.from.y} L {conn.to.x},{conn.to.y}"
                  />
                </circle>
                <!-- Reverse packet -->
                <circle class="data-packet packet-reverse" r="0.8" style="animation-delay: {i * 0.3 + 1}s">
                  <animateMotion
                    dur="2s"
                    repeatCount="indefinite"
                    begin="{i * 0.3 + 1}s"
                    path="M {conn.to.x},{conn.to.y} L {conn.from.x},{conn.from.y}"
                  />
                </circle>
              </g>
            {/each}

            <!-- Nodes -->
            {#each nodes as node, i}
              <g
                class="node-group"
                class:visible={nodesVisible}
                class:local={node.isLocal}
                style="animation-delay: {i * 0.1}s"
                transform="translate({node.x}, {node.y})"
              >
                <!-- Pulse ring for local node -->
                {#if node.isLocal}
                  <circle class="pulse-ring" r="8" />
                  <circle class="pulse-ring pulse-ring-2" r="8" />
                {/if}
                <!-- Node background glow -->
                <circle
                  class="node-glow"
                  r={node.isLocal ? 7 : 5}
                />
                <!-- Node circle -->
                <circle
                  class="node-circle"
                  r={node.isLocal ? 5 : 3.5}
                />
                <!-- Node icon -->
                {#if node.isLocal}
                  <circle class="node-inner" r="2" />
                {:else}
                  <circle class="node-inner" r="1.2" />
                {/if}
              </g>
            {/each}
          </svg>

          <!-- Labels -->
          <div class="cluster-labels" class:visible={nodesVisible}>
            <span class="label label-local">{translations.nodeLabels.local}</span>
            <span class="label label-remote">{translations.nodeLabels.remote}</span>
          </div>
        </div>

        <!-- Badges -->
        <div class="cluster-badges" class:visible={connectionsActive}>
          <span class="badge badge-primary">{translations.badges.autoDiscovery}</span>
          <span class="badge badge-secondary">{translations.badges.noSinglePoint}</span>
          <span class="badge badge-primary">{translations.badges.seamless}</span>
        </div>
      </div>

      <!-- Features and code -->
      <div class="features-code-container">
        <!-- Feature cards -->
        <div class="features-list">
          {#each features as feature, index}
            <div
              class="feature-card"
              class:visible={featuresVisible[index]}
              class:accent-primary={feature.accent === 'primary'}
              class:accent-secondary={feature.accent === 'secondary'}
            >
              <div class="feature-icon" aria-hidden="true">
                {#if feature.icon === 'cluster'}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="12" cy="12" r="3" />
                    <circle cx="5" cy="6" r="2" />
                    <circle cx="19" cy="6" r="2" />
                    <circle cx="5" cy="18" r="2" />
                    <circle cx="19" cy="18" r="2" />
                    <path d="M9.5 10.5L6.5 7.5" />
                    <path d="M14.5 10.5l3-3" />
                    <path d="M9.5 13.5l-3 3" />
                    <path d="M14.5 13.5l3 3" />
                  </svg>
                {:else if feature.icon === 'global'}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M2 12h20" />
                    <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                  </svg>
                {:else if feature.icon === 'transparent'}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M4 4h6v6H4z" />
                    <path d="M14 4h6v6h-6z" />
                    <path d="M4 14h6v6H4z" />
                    <path d="M14 14h6v6h-6z" />
                    <path d="M10 7h4" />
                    <path d="M7 10v4" />
                    <path d="M17 10v4" />
                    <path d="M10 17h4" />
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

        <!-- Code example -->
        <div class="code-container" class:visible={codeVisible}>
          <div class="code-block">
            <div class="code-header">
              <span class="code-dot code-dot-red"></span>
              <span class="code-dot code-dot-yellow"></span>
              <span class="code-dot code-dot-green"></span>
              <span class="code-filename">cluster.ts</span>
            </div>
            <pre class="code-content"><code>{@html highlightCode(codeSnippet)}</code></pre>
          </div>
          <p class="code-hint">{translations.codeHint}</p>
        </div>
      </div>
    </div>
  </div>
</section>

<script context="module" lang="ts">
  function highlightCode(code: string): string {
    return code
      // Keywords
      .replace(/\b(const|let|await|async|type)\b/g, '<span class="hl-keyword">$1</span>')
      // Classes/Types
      .replace(/\b(GlobalRegistry|GenServer)\b/g, '<span class="hl-class">$1</span>')
      // Methods
      .replace(/\b(register|whereis|call)\b/g, '<span class="hl-method">$1</span>')
      // Strings
      .replace(/'([^']+)'/g, '<span class="hl-string">\'$1\'</span>')
      // Properties
      .replace(/\b(type)\b(?=\s*:)/g, '<span class="hl-property">$1</span>')
      // Comments
      .replace(/(\/\/[^\n]*)/g, '<span class="hl-comment">$1</span>');
  }
</script>

<style>
  .distribution-section {
    position: relative;
    overflow: hidden;
    max-width: 100vw;
  }

  .content-wrapper {
    max-width: 100%;
    overflow-x: hidden;
    padding-left: 1rem;
    padding-right: 1rem;
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
    width: 500px;
    height: 500px;
    background: var(--color-accent-primary);
    top: -100px;
    left: -150px;
    animation: orbFloat1 20s ease-in-out infinite;
  }

  .gradient-orb-2 {
    width: 450px;
    height: 450px;
    background: var(--color-accent-secondary);
    bottom: -100px;
    right: -150px;
    animation: orbFloat2 18s ease-in-out infinite;
  }

  .hex-pattern {
    position: absolute;
    inset: 0;
    background-image:
      radial-gradient(circle at 25% 25%, rgba(0, 255, 136, 0.03) 2px, transparent 2px),
      radial-gradient(circle at 75% 75%, rgba(0, 212, 255, 0.03) 2px, transparent 2px);
    background-size: 50px 50px;
  }

  @keyframes orbFloat1 {
    0%, 100% { transform: translate(0, 0); }
    50% { transform: translate(40px, 30px); }
  }

  @keyframes orbFloat2 {
    0%, 100% { transform: translate(0, 0); }
    50% { transform: translate(-30px, -40px); }
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
  .distribution-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 2rem;
    max-width: 100%;
    overflow-x: hidden;
  }

  @media (min-width: 1024px) {
    .distribution-grid {
      grid-template-columns: 1fr 1.2fr;
      gap: 3rem;
      align-items: start;
    }
  }

  /* Cluster container */
  .cluster-container {
    opacity: 0;
    transform: translateY(30px);
    transition: opacity 0.6s ease-out 0.2s, transform 0.6s ease-out 0.2s;
    max-width: 100%;
    overflow-x: hidden;
  }

  .cluster-container.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .cluster-visualization {
    position: relative;
    background: rgba(18, 18, 26, 0.6);
    backdrop-filter: blur(12px);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    padding: 2rem;
    overflow: hidden;
  }

  .cluster-svg {
    width: 100%;
    height: auto;
    max-height: 280px;
  }

  /* Connection lines */
  .connection-group {
    opacity: 0;
    transition: opacity 0.5s ease-out;
  }

  .connection-group.active {
    opacity: 1;
  }

  .connection-line {
    stroke: var(--color-border);
    stroke-width: 0.3;
    stroke-dasharray: 2 2;
    opacity: 0.5;
    transition: stroke 0.3s ease, opacity 0.3s ease;
  }

  .connection-group.active .connection-line {
    stroke: var(--color-accent-secondary);
    opacity: 0.4;
    animation: lineGlow 3s ease-in-out infinite;
  }

  @keyframes lineGlow {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 0.6; }
  }

  .data-packet {
    fill: var(--color-accent-primary);
    opacity: 0;
  }

  .connection-group.active .data-packet {
    opacity: 0.9;
    filter: drop-shadow(0 0 3px var(--color-accent-primary));
  }

  .packet-reverse {
    fill: var(--color-accent-secondary);
  }

  .connection-group.active .packet-reverse {
    filter: drop-shadow(0 0 3px var(--color-accent-secondary));
  }

  /* Nodes */
  .node-group {
    opacity: 0;
    transform: scale(0);
    transition: opacity 0.4s ease-out, transform 0.4s ease-out;
  }

  .node-group.visible {
    opacity: 1;
    transform: scale(1);
  }

  .node-glow {
    fill: var(--color-accent-secondary);
    opacity: 0.15;
    filter: blur(3px);
  }

  .node-group.local .node-glow {
    fill: var(--color-accent-primary);
    opacity: 0.2;
  }

  .node-circle {
    fill: var(--color-bg-card);
    stroke: var(--color-accent-secondary);
    stroke-width: 0.5;
    transition: stroke 0.3s ease;
  }

  .node-group.local .node-circle {
    stroke: var(--color-accent-primary);
    stroke-width: 0.8;
  }

  .node-inner {
    fill: var(--color-accent-secondary);
  }

  .node-group.local .node-inner {
    fill: var(--color-accent-primary);
  }

  /* Pulse rings for local node */
  .pulse-ring {
    fill: none;
    stroke: var(--color-accent-primary);
    stroke-width: 0.3;
    opacity: 0;
    transform-origin: center;
  }

  .node-group.visible .pulse-ring {
    animation: pulseExpand 2.5s ease-out infinite;
  }

  .pulse-ring-2 {
    animation-delay: 1.25s !important;
  }

  @keyframes pulseExpand {
    0% {
      transform: scale(1);
      opacity: 0.6;
    }
    100% {
      transform: scale(2.5);
      opacity: 0;
    }
  }

  /* Labels */
  .cluster-labels {
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.5s ease-out 0.3s;
  }

  .cluster-labels.visible {
    opacity: 1;
  }

  .label {
    position: absolute;
    font-size: 0.7rem;
    font-weight: 500;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    background: rgba(10, 10, 15, 0.8);
    border: 1px solid var(--color-border);
  }

  .label-local {
    top: 50%;
    left: 50%;
    transform: translate(-50%, 30px);
    color: var(--color-accent-primary);
    border-color: rgba(0, 255, 136, 0.3);
  }

  .label-remote {
    top: 1rem;
    right: 1rem;
    color: var(--color-accent-secondary);
    border-color: rgba(0, 212, 255, 0.3);
  }

  /* Badges */
  .cluster-badges {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
    margin-top: 1.5rem;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.5s ease-out, transform 0.5s ease-out;
  }

  .cluster-badges.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .badge {
    padding: 0.375rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.75rem;
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
    box-shadow: 0 4px 15px rgba(0, 255, 136, 0.2);
  }

  .badge-secondary {
    background: rgba(0, 212, 255, 0.1);
    color: var(--color-accent-secondary);
    border: 1px solid rgba(0, 212, 255, 0.3);
  }

  .badge-secondary:hover {
    box-shadow: 0 4px 15px rgba(0, 212, 255, 0.2);
  }

  /* Features and code container */
  .features-code-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 100%;
    overflow-x: hidden;
  }

  /* Features list */
  .features-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 100%;
  }

  .feature-card {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1rem 1.25rem;
    background: rgba(18, 18, 26, 0.5);
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
    box-shadow: 0 0 25px rgba(0, 255, 136, 0.1);
  }

  .feature-card.accent-secondary:hover {
    border-color: var(--color-accent-secondary);
    box-shadow: 0 0 25px rgba(0, 212, 255, 0.1);
  }

  .feature-icon {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    transition: transform 0.3s ease;
  }

  .feature-icon svg {
    width: 20px;
    height: 20px;
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
    font-size: 0.95rem;
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
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    line-height: 1.5;
  }

  .feature-glow {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 50px;
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

  /* Code container */
  .code-container {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease-out, transform 0.5s ease-out;
  }

  .code-container.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .code-block {
    background: rgba(10, 10, 15, 0.9);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    overflow: hidden;
    max-width: 100%;
    transition: border-color 0.3s ease, box-shadow 0.3s ease;
  }

  .code-block:hover {
    border-color: rgba(0, 255, 136, 0.3);
    box-shadow: 0 0 30px rgba(0, 255, 136, 0.08);
  }

  .code-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid var(--color-border);
  }

  .code-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .code-dot-red { background: #ff5f56; }
  .code-dot-yellow { background: #ffbd2e; }
  .code-dot-green { background: #27ca40; }

  .code-filename {
    margin-left: auto;
    font-size: 0.7rem;
    color: var(--color-text-secondary);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }

  .code-content {
    padding: 1rem 1.25rem;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.72rem;
    line-height: 1.7;
    overflow-x: auto;
    margin: 0;
    color: var(--color-text-secondary);
  }

  .code-content code {
    display: block;
    white-space: pre;
  }

  /* Syntax highlighting */
  .code-content :global(.hl-keyword) {
    color: var(--color-accent-secondary);
  }

  .code-content :global(.hl-class) {
    color: var(--color-accent-primary);
  }

  .code-content :global(.hl-method) {
    color: #dcdcaa;
  }

  .code-content :global(.hl-string) {
    color: #ce9178;
  }

  .code-content :global(.hl-property) {
    color: #9cdcfe;
  }

  .code-content :global(.hl-comment) {
    color: #6a9955;
    font-style: italic;
  }

  .code-hint {
    margin-top: 0.75rem;
    text-align: center;
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    opacity: 0.8;
  }

  /* Responsive */
  @media (max-width: 1024px) {
    .cluster-visualization {
      max-width: 450px;
      margin: 0 auto;
    }
  }

  @media (max-width: 768px) {
    .cluster-visualization {
      padding: 1.5rem;
    }

    .cluster-svg {
      max-height: 220px;
    }

    .feature-card {
      padding: 0.875rem 1rem;
    }

    .feature-icon {
      width: 32px;
      height: 32px;
    }

    .feature-icon svg {
      width: 18px;
      height: 18px;
    }

    .code-content {
      font-size: 0.65rem;
      padding: 0.875rem 1rem;
    }

    .gradient-orb-1 {
      width: 280px;
      height: 280px;
      opacity: 0.05;
    }

    .gradient-orb-2 {
      width: 250px;
      height: 250px;
      opacity: 0.05;
    }

    .label {
      font-size: 0.6rem;
    }
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .section-title,
    .section-subtitle,
    .cluster-container,
    .feature-card,
    .code-container,
    .cluster-badges,
    .cluster-labels {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .node-group {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .connection-group {
      transition: none;
      opacity: 1;
    }

    .connection-line {
      animation: none;
    }

    .pulse-ring {
      animation: none;
      opacity: 0.3;
      transform: scale(1.5);
    }

    .data-packet {
      display: none;
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
