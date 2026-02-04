<script lang="ts">
  import { onMount } from 'svelte';

  interface ApplicationTranslations {
    title: string;
    subtitle: string;
    features: {
      lifecycle: string;
      signals: string;
      graceful: string;
    };
    descriptions: {
      lifecycle: string;
      signals: string;
      graceful: string;
    };
    badges: {
      kubernetes: string;
      docker: string;
      production: string;
    };
  }

  interface Props {
    translations: ApplicationTranslations;
  }

  let { translations }: Props = $props();

  let sectionRef: HTMLElement | null = $state(null);
  let isVisible = $state(false);
  let cardsVisible = $state([false, false, false]);
  let activeCard = $state<number | null>(null);
  let codeVisible = $state(false);

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
              }, 200 * (index + 1));
            });
            // Show code after cards
            setTimeout(() => {
              codeVisible = true;
            }, 800);
          }
        });
      },
      { threshold: 0.15 }
    );

    observer.observe(sectionRef);

    return () => observer.disconnect();
  });

  const codeSnippet = `const MyApp = Application.create({
  async start(config) {
    const supervisor = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'db', start: () => DatabasePool.start(config.dbUrl) },
        { id: 'api', start: () => ApiServer.start(config.port) }
      ]
    });
    return supervisor;
  },

  async prepStop(supervisor) {
    // Stop accepting new requests
  },

  async stop(supervisor) {
    // Final cleanup
  }
});

await Application.start(MyApp, {
  name: 'my-service',
  config: { port: 3000, dbUrl: 'postgres://...' }
});
// Handles SIGINT/SIGTERM automatically`;

  const features = $derived([
    {
      key: 'lifecycle' as const,
      icon: 'lifecycle',
      accent: 'primary',
      title: translations.features.lifecycle,
      description: translations.descriptions.lifecycle
    },
    {
      key: 'signals' as const,
      icon: 'signal',
      accent: 'secondary',
      title: translations.features.signals,
      description: translations.descriptions.signals
    },
    {
      key: 'graceful' as const,
      icon: 'graceful',
      accent: 'primary',
      title: translations.features.graceful,
      description: translations.descriptions.graceful
    }
  ]);
</script>

<section
  bind:this={sectionRef}
  id="application"
  class="application-section snap-section bg-bg-primary"
  aria-labelledby="application-title"
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
      id="application-title"
      class="section-title text-3xl md:text-5xl font-bold mb-4 text-text-primary text-center"
      class:visible={isVisible}
    >
      {translations.title}
    </h2>

    <!-- Subtitle -->
    <p
      class="section-subtitle text-lg text-text-secondary text-center mb-8 max-w-2xl mx-auto"
      class:visible={isVisible}
    >
      {translations.subtitle}
    </p>

    <!-- Badges -->
    <div class="badges-container mb-12 md:mb-16" class:visible={isVisible}>
      <span class="badge badge-primary">{translations.badges.kubernetes}</span>
      <span class="badge badge-secondary">{translations.badges.docker}</span>
      <span class="badge badge-primary">{translations.badges.production}</span>
    </div>

    <!-- Main content grid -->
    <div class="main-grid">
      <!-- Feature cards -->
      <div class="features-column">
        {#each features as feature, index}
          <article
            class="feature-card"
            class:visible={cardsVisible[index]}
            class:active={activeCard === index}
            class:accent-primary={feature.accent === 'primary'}
            class:accent-secondary={feature.accent === 'secondary'}
            onmouseenter={() => (activeCard = index)}
            onmouseleave={() => (activeCard = null)}
            onfocus={() => (activeCard = index)}
            onblur={() => (activeCard = null)}
            role="article"
            tabindex="0"
          >
            <div class="card-header">
              <div class="card-icon" aria-hidden="true">
                {#if feature.icon === 'lifecycle'}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                {:else if feature.icon === 'signal'}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M5 12h14M5 12l4-4m-4 4l4 4" />
                    <rect x="15" y="8" width="4" height="8" rx="1" />
                  </svg>
                {:else if feature.icon === 'graceful'}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                    <path d="M8 16l-2 2M16 16l2 2" />
                  </svg>
                {/if}
              </div>
              <h3 class="card-title text-lg font-bold">
                {feature.title}
              </h3>
            </div>
            <p class="card-description text-text-secondary text-sm leading-relaxed">
              {feature.description}
            </p>
            <!-- Hover glow -->
            <div class="card-glow" aria-hidden="true"></div>
          </article>
        {/each}
      </div>

      <!-- Code snippet -->
      <div class="code-column" class:visible={codeVisible}>
        <div class="code-block">
          <div class="code-header">
            <span class="code-dot code-dot-red"></span>
            <span class="code-dot code-dot-yellow"></span>
            <span class="code-dot code-dot-green"></span>
            <span class="code-filename">application.ts</span>
          </div>
          <pre class="code-content"><code>{@html highlightCode(codeSnippet)}</code></pre>
        </div>
      </div>
    </div>
  </div>
</section>

<script context="module" lang="ts">
  function highlightCode(code: string): string {
    return code
      // Keywords
      .replace(/\b(const|let|new|await|async|return)\b/g, '<span class="hl-keyword">$1</span>')
      // Classes/Types
      .replace(/\b(Application|Supervisor|DatabasePool|ApiServer)\b/g, '<span class="hl-class">$1</span>')
      // Methods
      .replace(/\b(create|start|prepStop|stop)\b/g, '<span class="hl-method">$1</span>')
      // Strings
      .replace(/'([^']+)'/g, '<span class="hl-string">\'$1\'</span>')
      // Numbers
      .replace(/\b(\d+)\b/g, '<span class="hl-number">$1</span>')
      // Properties
      .replace(/\b(strategy|children|id|name|config|port|dbUrl)\b(?=\s*:)/g, '<span class="hl-property">$1</span>')
      // Comments
      .replace(/(\/\/[^\n]*)/g, '<span class="hl-comment">$1</span>')
      // Arrow functions
      .replace(/=&gt;/g, '<span class="hl-keyword">=&gt;</span>');
  }
</script>

<style>
  .application-section {
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
    filter: blur(100px);
    opacity: 0.08;
  }

  .gradient-orb-1 {
    width: 600px;
    height: 600px;
    background: var(--color-accent-primary);
    top: -200px;
    right: -200px;
    animation: orbFloat1 20s ease-in-out infinite;
  }

  .gradient-orb-2 {
    width: 400px;
    height: 400px;
    background: var(--color-accent-secondary);
    bottom: -100px;
    left: -100px;
    animation: orbFloat2 18s ease-in-out infinite;
  }

  .dot-pattern {
    position: absolute;
    inset: 0;
    background-image: radial-gradient(rgba(0, 255, 136, 0.06) 1px, transparent 1px);
    background-size: 24px 24px;
  }

  @keyframes orbFloat1 {
    0%, 100% { transform: translate(0, 0); }
    50% { transform: translate(-40px, 40px); }
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

  /* Badges */
  .badges-container {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    opacity: 0;
    transform: translateY(15px);
    transition: opacity 0.6s ease-out 0.3s, transform 0.6s ease-out 0.3s;
  }

  .badges-container.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .badge {
    font-size: 0.75rem;
    padding: 0.375rem 0.875rem;
    border-radius: 9999px;
    font-weight: 500;
    border: 1px solid;
    transition: all 0.2s ease;
  }

  .badge-primary {
    background: rgba(0, 255, 136, 0.1);
    border-color: rgba(0, 255, 136, 0.3);
    color: var(--color-accent-primary);
  }

  .badge-secondary {
    background: rgba(0, 212, 255, 0.1);
    border-color: rgba(0, 212, 255, 0.3);
    color: var(--color-accent-secondary);
  }

  .badge:hover {
    transform: translateY(-2px);
  }

  .badge-primary:hover {
    background: rgba(0, 255, 136, 0.15);
    box-shadow: 0 4px 12px rgba(0, 255, 136, 0.2);
  }

  .badge-secondary:hover {
    background: rgba(0, 212, 255, 0.15);
    box-shadow: 0 4px 12px rgba(0, 212, 255, 0.2);
  }

  /* Main grid */
  .main-grid {
    display: grid;
    gap: 2rem;
    max-width: 100%;
    overflow-x: hidden;
  }

  @media (min-width: 1024px) {
    .main-grid {
      grid-template-columns: 1fr 1.5fr;
      gap: 3rem;
      align-items: start;
    }
  }

  /* Features column */
  .features-column {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 100%;
    overflow-x: hidden;
  }

  /* Feature cards */
  .feature-card {
    position: relative;
    background: rgba(18, 18, 26, 0.7);
    backdrop-filter: blur(16px);
    border: 1px solid var(--color-border);
    border-radius: 1rem;
    padding: 1.25rem;
    opacity: 0;
    transform: translateX(-30px);
    transition:
      opacity 0.5s ease-out,
      transform 0.5s ease-out,
      border-color 0.3s ease,
      box-shadow 0.3s ease;
    overflow: hidden;
    cursor: default;
    outline: none;
    max-width: 100%;
    box-sizing: border-box;
  }

  .feature-card.visible {
    opacity: 1;
    transform: translateX(0);
  }

  .feature-card:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
  }

  .feature-card.accent-primary:hover,
  .feature-card.accent-primary.active {
    border-color: var(--color-accent-primary);
    box-shadow: 0 0 30px rgba(0, 255, 136, 0.1);
  }

  .feature-card.accent-secondary:hover,
  .feature-card.accent-secondary.active {
    border-color: var(--color-accent-secondary);
    box-shadow: 0 0 30px rgba(0, 212, 255, 0.1);
  }

  /* Card header */
  .card-header {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    margin-bottom: 0.75rem;
  }

  .card-icon {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    transition: transform 0.3s ease, background 0.3s ease;
  }

  .card-icon svg {
    width: 22px;
    height: 22px;
  }

  .accent-primary .card-icon {
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.15), rgba(0, 255, 136, 0.05));
    color: var(--color-accent-primary);
  }

  .accent-secondary .card-icon {
    background: linear-gradient(135deg, rgba(0, 212, 255, 0.15), rgba(0, 212, 255, 0.05));
    color: var(--color-accent-secondary);
  }

  .feature-card:hover .card-icon,
  .feature-card.active .card-icon {
    transform: scale(1.1);
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

  /* Card glow */
  .card-glow {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 60px;
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

  .feature-card:hover .card-glow,
  .feature-card.active .card-glow {
    opacity: 1;
  }

  /* Code column */
  .code-column {
    opacity: 0;
    transform: translateY(30px);
    transition: opacity 0.6s ease-out, transform 0.6s ease-out;
    max-width: 100%;
    overflow-x: hidden;
  }

  .code-column.visible {
    opacity: 1;
    transform: translateY(0);
  }

  /* Code block */
  .code-block {
    background: rgba(10, 10, 15, 0.9);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    overflow: hidden;
    max-width: 100%;
  }

  .code-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 16px;
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
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }

  .code-content {
    padding: 1.25rem;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.75rem;
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

  /* Responsive */
  @media (max-width: 1024px) {
    .main-grid {
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
    }
  }

  @media (max-width: 768px) {
    .main-grid {
      max-width: 100%;
    }

    .feature-card {
      padding: 1rem;
      max-width: 100%;
    }

    .card-icon {
      width: 36px;
      height: 36px;
    }

    .card-icon svg {
      width: 18px;
      height: 18px;
    }

    .code-block {
      max-width: 100%;
    }

    .code-content {
      font-size: 0.65rem;
      padding: 1rem;
      max-width: 100%;
    }

    .gradient-orb-1 {
      width: 300px;
      height: 300px;
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
    .badges-container,
    .feature-card,
    .code-column {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .gradient-orb-1,
    .gradient-orb-2 {
      animation: none;
    }

    .feature-card:hover,
    .feature-card.active {
      transform: none;
    }

    .feature-card:hover .card-icon,
    .feature-card.active .card-icon {
      transform: none;
    }

    .badge:hover {
      transform: none;
    }
  }
</style>
