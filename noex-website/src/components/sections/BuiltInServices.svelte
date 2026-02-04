<script lang="ts">
  import { onMount } from 'svelte';

  interface Service {
    title: string;
    description: string;
  }

  interface ServicesTranslations {
    title: string;
    subtitle: string;
    cache: Service;
    eventbus: Service;
    ratelimiter: Service;
    ets: Service;
  }

  interface Props {
    translations: ServicesTranslations;
  }

  let { translations }: Props = $props();

  let sectionRef: HTMLElement | null = $state(null);
  let isVisible = $state(false);
  let cardsVisible = $state([false, false, false, false]);
  let activeCard = $state<number | null>(null);
  let connectionsVisible = $state(false);
  let expandedCode = $state<{ title: string; code: string; filename: string } | null>(null);

  onMount(() => {
    if (!sectionRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            isVisible = true;
            // Stagger card animations
            cardsVisible.forEach((_, index) => {
              setTimeout(() => {
                cardsVisible[index] = true;
              }, 250 * (index + 1));
            });
            // Show connections after cards
            setTimeout(() => {
              connectionsVisible = true;
            }, 1000);
          }
        });
      },
      { threshold: 0.15 }
    );

    observer.observe(sectionRef);

    return () => observer.disconnect();
  });

  function openCodeModal(title: string, code: string, filename: string) {
    expandedCode = { title, code, filename };
    document.body.style.overflow = 'hidden';
  }

  function closeCodeModal() {
    expandedCode = null;
    document.body.style.overflow = '';
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && expandedCode) {
      closeCodeModal();
    }
  }

  // Code snippets for each service
  const codeSnippets = {
    cache: `// Cache with TTL
const cache = new Cache({ ttl: 60_000 });

await cache.set('user:123', userData);
const user = await cache.get('user:123');

// Auto-cleanup on expiration`,
    eventbus: `// Pub/sub messaging
const bus = new EventBus();

bus.subscribe('order:created', async (order) => {
  await sendConfirmation(order);
});

bus.publish('order:created', newOrder);`,
    ratelimiter: `// Token bucket rate limiting
const limiter = new RateLimiter({
  tokens: 100,
  interval: 60_000
});

if (await limiter.acquire('api:user:123')) {
  // Process request
}`,
    ets: `// In-memory key-value storage
const users = new EtsTable({ name: 'users', type: 'set' });
await users.start();

users.insert('user:1', { name: 'Alice', score: 100 });
const alice = users.lookup('user:1');
const top = users.select(([k, v]) => v.score > 50);`
  };

  const services = $derived([
    {
      key: 'cache' as const,
      icon: 'database',
      accent: 'primary',
      data: translations.cache,
      code: codeSnippets.cache,
      useCases: ['Session storage', 'API responses', 'Computed data']
    },
    {
      key: 'eventbus' as const,
      icon: 'broadcast',
      accent: 'secondary',
      data: translations.eventbus,
      code: codeSnippets.eventbus,
      useCases: ['Decoupled communication', 'Event sourcing', 'Real-time updates']
    },
    {
      key: 'ratelimiter' as const,
      icon: 'gauge',
      accent: 'primary',
      data: translations.ratelimiter,
      code: codeSnippets.ratelimiter,
      useCases: ['API protection', 'Resource throttling', 'DoS prevention']
    },
    {
      key: 'ets' as const,
      icon: 'table',
      accent: 'secondary',
      data: translations.ets,
      code: codeSnippets.ets,
      useCases: ['Fast lookups', 'Session data', 'Shared state']
    }
  ]);
</script>

<section
  bind:this={sectionRef}
  id="services"
  class="services-section snap-section bg-bg-secondary"
  aria-labelledby="services-title"
>
  <!-- Background elements -->
  <div class="background-elements" aria-hidden="true">
    <div class="gradient-orb gradient-orb-1"></div>
    <div class="gradient-orb gradient-orb-2"></div>
    <div class="dot-pattern"></div>
  </div>

  <div class="content-wrapper max-w-6xl mx-auto relative z-10">
    <!-- Title -->
    <h2
      id="services-title"
      class="section-title text-3xl md:text-5xl font-bold mb-4 text-text-primary text-center"
      class:visible={isVisible}
    >
      {translations.title}
    </h2>

    <!-- Subtitle -->
    <p
      class="section-subtitle text-lg text-text-secondary text-center mb-12 md:mb-16 max-w-2xl mx-auto"
      class:visible={isVisible}
    >
      {translations.subtitle}
    </p>

    <!-- Services grid with connections -->
    <div class="services-container">
      <!-- Connection lines (desktop only) -->
      <svg class="connections-svg" aria-hidden="true" class:visible={connectionsVisible}>
        <!-- Line from Cache to EventBus -->
        <path
          class="connection-line connection-line-1"
          d="M 33% 50% Q 50% 30%, 67% 50%"
          fill="none"
        />
        <!-- Line from EventBus to RateLimiter -->
        <path
          class="connection-line connection-line-2"
          d="M 67% 50% Q 83% 70%, 100% 50%"
          fill="none"
        />
        <!-- Animated particles -->
        <circle class="particle particle-1" r="3">
          <animateMotion
            dur="3s"
            repeatCount="indefinite"
            path="M 33% 50% Q 50% 30%, 67% 50%"
          />
        </circle>
        <circle class="particle particle-2" r="3">
          <animateMotion
            dur="3s"
            repeatCount="indefinite"
            path="M 67% 50% Q 83% 70%, 100% 50%"
            begin="1.5s"
          />
        </circle>
      </svg>

      <!-- Service cards -->
      <div class="cards-grid grid md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
        {#each services as service, index}
          <article
            class="service-card"
            class:visible={cardsVisible[index]}
            class:active={activeCard === index}
            class:accent-primary={service.accent === 'primary'}
            class:accent-secondary={service.accent === 'secondary'}
            onmouseenter={() => (activeCard = index)}
            onmouseleave={() => (activeCard = null)}
            onfocus={() => (activeCard = index)}
            onblur={() => (activeCard = null)}
            role="article"
            tabindex="0"
          >
            <!-- Card header -->
            <div class="card-header">
              <div class="card-icon" aria-hidden="true">
                {#if service.icon === 'database'}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <ellipse cx="12" cy="5" rx="9" ry="3" />
                    <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
                    <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
                  </svg>
                {:else if service.icon === 'broadcast'}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
                    <path d="M7.8 16.2a5.5 5.5 0 0 1 0-8.4" />
                    <circle cx="12" cy="12" r="2" />
                    <path d="M16.2 7.8a5.5 5.5 0 0 1 0 8.4" />
                    <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1" />
                  </svg>
                {:else if service.icon === 'gauge'}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                    <path d="M12 6v6l4 2" />
                    <path d="M16.24 7.76l-1.41 1.41" stroke-linecap="round" />
                  </svg>
                {:else if service.icon === 'table'}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M3 9h18" />
                    <path d="M3 15h18" />
                    <path d="M9 3v18" />
                  </svg>
                {/if}
              </div>
              <h3 class="card-title text-xl font-bold">
                {service.data.title}
              </h3>
            </div>

            <!-- Description -->
            <p class="card-description text-text-secondary leading-relaxed mb-4">
              {service.data.description}
            </p>

            <!-- Use cases -->
            <div class="use-cases mb-4">
              {#each service.useCases as useCase}
                <span class="use-case-tag">{useCase}</span>
              {/each}
            </div>

            <!-- Code snippet -->
            <button
              class="code-block"
              onclick={() => openCodeModal(service.data.title, service.code, `${service.key}.ts`)}
              aria-label="Expand code"
              title="Click to expand"
            >
              <div class="code-header">
                <span class="code-dot code-dot-red"></span>
                <span class="code-dot code-dot-yellow"></span>
                <span class="code-dot code-dot-green"></span>
                <span class="code-filename">{service.key}.ts</span>
                <span class="expand-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                </span>
              </div>
              <pre class="code-content"><code>{@html highlightCode(service.code)}</code></pre>
            </button>

            <!-- Connection indicator -->
            <div class="connection-indicator" aria-hidden="true">
              <div class="pulse-ring"></div>
              <div class="pulse-dot"></div>
            </div>

            <!-- Hover glow -->
            <div class="card-glow" aria-hidden="true"></div>
          </article>
        {/each}
      </div>
    </div>
  </div>

  <!-- Code Modal -->
  {#if expandedCode}
    <div
      class="code-modal-overlay"
      onclick={closeCodeModal}
      onkeydown={handleKeydown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      tabindex="-1"
    >
      <div class="code-modal" onclick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h3 id="modal-title" class="modal-title">{expandedCode.title}</h3>
          <button class="modal-close" onclick={closeCodeModal} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="modal-code-block">
          <div class="modal-code-header">
            <span class="code-dot code-dot-red"></span>
            <span class="code-dot code-dot-yellow"></span>
            <span class="code-dot code-dot-green"></span>
            <span class="code-filename">{expandedCode.filename}</span>
          </div>
          <pre class="modal-code-content"><code>{@html highlightCode(expandedCode.code)}</code></pre>
        </div>
      </div>
    </div>
  {/if}
</section>

<script context="module" lang="ts">
  function highlightCode(code: string): string {
    return code
      // Keywords
      .replace(/\b(const|let|new|await|async|if|return)\b/g, '<span class="hl-keyword">$1</span>')
      // Classes/Types
      .replace(/\b(Cache|EventBus|RateLimiter|EtsTable)\b/g, '<span class="hl-class">$1</span>')
      // Methods
      .replace(/\b(set|get|subscribe|publish|acquire|sendConfirmation|start|insert|lookup|select)\b/g, '<span class="hl-method">$1</span>')
      // Strings
      .replace(/'([^']+)'/g, '<span class="hl-string">\'$1\'</span>')
      // Numbers
      .replace(/\b(\d+(_\d+)?)\b/g, '<span class="hl-number">$1</span>')
      // Properties
      .replace(/\b(ttl|tokens|interval|name|type|score)\b(?=\s*:)/g, '<span class="hl-property">$1</span>')
      // Comments
      .replace(/(\/\/[^\n]*)/g, '<span class="hl-comment">$1</span>')
      // Arrow functions
      .replace(/=&gt;/g, '<span class="hl-keyword">=&gt;</span>');
  }
</script>

<style>
  .services-section {
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
    filter: blur(100px);
    opacity: 0.1;
  }

  .gradient-orb-1 {
    width: 500px;
    height: 500px;
    background: var(--color-accent-secondary);
    top: -150px;
    left: -150px;
    animation: orbFloat1 20s ease-in-out infinite;
  }

  .gradient-orb-2 {
    width: 400px;
    height: 400px;
    background: var(--color-accent-primary);
    bottom: -100px;
    right: -100px;
    animation: orbFloat2 18s ease-in-out infinite;
  }

  .dot-pattern {
    position: absolute;
    inset: 0;
    background-image: radial-gradient(rgba(0, 212, 255, 0.08) 1px, transparent 1px);
    background-size: 24px 24px;
  }

  @keyframes orbFloat1 {
    0%, 100% { transform: translate(0, 0); }
    50% { transform: translate(50px, 30px); }
  }

  @keyframes orbFloat2 {
    0%, 100% { transform: translate(0, 0); }
    50% { transform: translate(-40px, -30px); }
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

  /* Services container */
  .services-container {
    position: relative;
  }

  /* Connection lines SVG */
  .connections-svg {
    display: none;
    position: absolute;
    top: 50%;
    left: 0;
    width: 100%;
    height: 200px;
    transform: translateY(-50%);
    z-index: 0;
    opacity: 0;
    transition: opacity 0.8s ease-out;
    pointer-events: none;
  }

  .connections-svg.visible {
    opacity: 1;
  }

  @media (min-width: 1024px) {
    .connections-svg {
      display: block;
    }
  }

  .connection-line {
    stroke: var(--color-accent-secondary);
    stroke-width: 2;
    stroke-dasharray: 8 4;
    opacity: 0.3;
    animation: dashMove 20s linear infinite;
  }

  .connection-line-2 {
    stroke: var(--color-accent-primary);
  }

  @keyframes dashMove {
    to {
      stroke-dashoffset: -120;
    }
  }

  .particle {
    fill: var(--color-accent-secondary);
    opacity: 0.8;
  }

  .particle-2 {
    fill: var(--color-accent-primary);
  }

  /* Service cards */
  .service-card {
    position: relative;
    background: rgba(18, 18, 26, 0.7);
    backdrop-filter: blur(16px);
    border: 1px solid var(--color-border);
    border-radius: 1rem;
    padding: 1.5rem;
    opacity: 0;
    transform: translateY(40px) scale(0.95);
    transition:
      opacity 0.5s ease-out,
      transform 0.5s ease-out,
      border-color 0.3s ease,
      box-shadow 0.3s ease;
    overflow: hidden;
    cursor: default;
    outline: none;
    z-index: 1;
  }

  .service-card.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .service-card:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
  }

  .service-card.accent-primary:hover,
  .service-card.accent-primary.active {
    border-color: var(--color-accent-primary);
    box-shadow:
      0 0 40px rgba(0, 255, 136, 0.12),
      0 20px 50px rgba(0, 0, 0, 0.3);
    transform: translateY(-6px) scale(1);
  }

  .service-card.accent-secondary:hover,
  .service-card.accent-secondary.active {
    border-color: var(--color-accent-secondary);
    box-shadow:
      0 0 40px rgba(0, 212, 255, 0.12),
      0 20px 50px rgba(0, 0, 0, 0.3);
    transform: translateY(-6px) scale(1);
  }

  /* Card header */
  .card-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .card-icon {
    width: 48px;
    height: 48px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    transition: transform 0.3s ease, background 0.3s ease;
  }

  .card-icon svg {
    width: 26px;
    height: 26px;
  }

  .accent-primary .card-icon {
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.15), rgba(0, 255, 136, 0.05));
    color: var(--color-accent-primary);
  }

  .accent-secondary .card-icon {
    background: linear-gradient(135deg, rgba(0, 212, 255, 0.15), rgba(0, 212, 255, 0.05));
    color: var(--color-accent-secondary);
  }

  .service-card:hover .card-icon,
  .service-card.active .card-icon {
    transform: scale(1.1);
  }

  .accent-primary:hover .card-icon,
  .accent-primary.active .card-icon {
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.25), rgba(0, 255, 136, 0.1));
  }

  .accent-secondary:hover .card-icon,
  .accent-secondary.active .card-icon {
    background: linear-gradient(135deg, rgba(0, 212, 255, 0.25), rgba(0, 212, 255, 0.1));
  }

  /* Card title */
  .card-title {
    color: var(--color-text-primary);
    transition: color 0.3s ease;
  }

  .accent-primary:hover .card-title,
  .accent-primary.active .card-title {
    color: var(--color-accent-primary);
  }

  .accent-secondary:hover .card-title,
  .accent-secondary.active .card-title {
    color: var(--color-accent-secondary);
  }

  /* Use cases tags */
  .use-cases {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .use-case-tag {
    font-size: 0.7rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    background: rgba(255, 255, 255, 0.05);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    transition: all 0.2s ease;
  }

  .accent-primary:hover .use-case-tag,
  .accent-primary.active .use-case-tag {
    border-color: rgba(0, 255, 136, 0.3);
    color: var(--color-accent-primary);
  }

  .accent-secondary:hover .use-case-tag,
  .accent-secondary.active .use-case-tag {
    border-color: rgba(0, 212, 255, 0.3);
    color: var(--color-accent-secondary);
  }

  /* Code block */
  .code-block {
    width: 100%;
    text-align: left;
    background: rgba(10, 10, 15, 0.9);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
    transition: border-color 0.3s ease, transform 0.2s ease;
    cursor: pointer;
  }

  .code-block:hover {
    transform: scale(1.02);
  }

  .code-block:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
  }

  .accent-primary:hover .code-block,
  .accent-primary.active .code-block {
    border-color: rgba(0, 255, 136, 0.3);
  }

  .accent-secondary:hover .code-block,
  .accent-secondary.active .code-block {
    border-color: rgba(0, 212, 255, 0.3);
  }

  .code-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
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

  .expand-icon {
    width: 16px;
    height: 16px;
    margin-left: 8px;
    color: var(--color-text-secondary);
    opacity: 0;
    transition: opacity 0.2s ease, color 0.2s ease;
  }

  .expand-icon svg {
    width: 100%;
    height: 100%;
  }

  .code-block:hover .expand-icon {
    opacity: 1;
  }

  .accent-primary .code-block:hover .expand-icon {
    color: var(--color-accent-primary);
  }

  .accent-secondary .code-block:hover .expand-icon {
    color: var(--color-accent-secondary);
  }

  .code-content {
    padding: 1rem;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.7rem;
    line-height: 1.6;
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

  .code-content :global(.hl-number) {
    color: #b5cea8;
  }

  .code-content :global(.hl-property) {
    color: #9cdcfe;
  }

  .code-content :global(.hl-comment) {
    color: #6a9955;
    font-style: italic;
  }

  /* Connection indicator */
  .connection-indicator {
    position: absolute;
    top: 50%;
    right: -8px;
    transform: translateY(-50%);
    display: none;
  }

  @media (min-width: 1024px) {
    .connection-indicator {
      display: block;
    }

    .service-card:last-child .connection-indicator {
      display: none;
    }
  }

  .pulse-ring {
    position: absolute;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--color-accent-secondary);
    opacity: 0;
    animation: pulseRing 2s ease-out infinite;
  }

  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-accent-secondary);
    position: relative;
    left: 4px;
    top: 4px;
  }

  .accent-primary .pulse-ring {
    border-color: var(--color-accent-primary);
  }

  .accent-primary .pulse-dot {
    background: var(--color-accent-primary);
  }

  @keyframes pulseRing {
    0% {
      transform: scale(1);
      opacity: 0.8;
    }
    100% {
      transform: scale(2.5);
      opacity: 0;
    }
  }

  /* Card glow */
  .card-glow {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 100px;
    opacity: 0;
    transition: opacity 0.3s ease;
    pointer-events: none;
  }

  .accent-primary .card-glow {
    background: linear-gradient(to bottom, rgba(0, 255, 136, 0.08), transparent);
  }

  .accent-secondary .card-glow {
    background: linear-gradient(to bottom, rgba(0, 212, 255, 0.08), transparent);
  }

  .service-card:hover .card-glow,
  .service-card.active .card-glow {
    opacity: 1;
  }

  /* Responsive */
  @media (max-width: 1024px) {
    .cards-grid {
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
    }
  }

  @media (max-width: 768px) {
    .service-card {
      padding: 1.25rem;
    }

    .card-icon {
      width: 42px;
      height: 42px;
    }

    .card-icon svg {
      width: 22px;
      height: 22px;
    }

    .code-content {
      font-size: 0.65rem;
      padding: 0.75rem;
    }

    .gradient-orb-1 {
      width: 280px;
      height: 280px;
      opacity: 0.06;
    }

    .gradient-orb-2 {
      width: 220px;
      height: 220px;
      opacity: 0.06;
    }
  }

  @media (max-width: 640px) {
    .code-modal-overlay {
      padding: 0.5rem;
    }

    .modal-code-content {
      font-size: 0.8rem;
      padding: 1rem;
    }
  }

  /* Code Modal */
  .code-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(8px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .code-modal {
    background: rgba(18, 18, 26, 0.98);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    max-width: 700px;
    width: 100%;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.3s ease-out;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(20px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .modal-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0;
  }

  .modal-close {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .modal-close:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--color-text-primary);
    border-color: var(--color-accent-primary);
  }

  .modal-close svg {
    width: 20px;
    height: 20px;
  }

  .modal-code-block {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .modal-code-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid var(--color-border);
  }

  .modal-code-content {
    flex: 1;
    overflow: auto;
    padding: 1.5rem;
    margin: 0;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.95rem;
    line-height: 1.7;
    color: var(--color-text-secondary);
  }

  .modal-code-content code {
    display: block;
    white-space: pre;
  }

  /* Modal syntax highlighting */
  .modal-code-content :global(.hl-keyword) {
    color: var(--color-accent-secondary);
  }

  .modal-code-content :global(.hl-class) {
    color: var(--color-accent-primary);
  }

  .modal-code-content :global(.hl-method) {
    color: #dcdcaa;
  }

  .modal-code-content :global(.hl-string) {
    color: #ce9178;
  }

  .modal-code-content :global(.hl-number) {
    color: #b5cea8;
  }

  .modal-code-content :global(.hl-property) {
    color: #9cdcfe;
  }

  .modal-code-content :global(.hl-comment) {
    color: #6a9955;
    font-style: italic;
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .section-title,
    .section-subtitle,
    .service-card {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .gradient-orb-1,
    .gradient-orb-2 {
      animation: none;
    }

    .connection-line {
      animation: none;
    }

    .pulse-ring {
      animation: none;
      opacity: 0.5;
      transform: scale(1.5);
    }

    .service-card:hover,
    .service-card.active {
      transform: none;
    }

    .service-card:hover .card-icon,
    .service-card.active .card-icon {
      transform: none;
    }

    .code-block:hover {
      transform: none;
    }

    .code-modal-overlay,
    .code-modal {
      animation: none;
    }
  }
</style>
