<script lang="ts">
  import { onMount } from 'svelte';

  interface Feature {
    title: string;
    description: string;
  }

  interface FeaturesTranslations {
    title: string;
    subtitle: string;
    genserver: Feature;
    supervisor: Feature;
    registry: Feature;
  }

  interface Props {
    translations: FeaturesTranslations;
  }

  let { translations }: Props = $props();

  // Intersection Observer for fade-in animations
  let sectionRef: HTMLElement | null = $state(null);
  let isVisible = $state(false);
  let cardsVisible = $state([false, false, false]);
  let activeCard = $state<number | null>(null);
  let expandedCode = $state<{ title: string; code: string; filename: string } | null>(null);

  onMount(() => {
    if (!sectionRef) return;

    const sectionObserver = new IntersectionObserver(
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
          }
        });
      },
      { threshold: 0.15 }
    );

    sectionObserver.observe(sectionRef);

    return () => {
      sectionObserver.disconnect();
    };
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

  // Code snippets for each feature
  const codeSnippets = {
    genserver: `class Counter extends GenServer<number> {
  init() { return 0; }

  handleCall(msg: 'get') {
    return this.state;
  }

  handleCast(msg: 'inc') {
    this.state++;
  }
}`,
    supervisor: `const supervisor = new Supervisor({
  children: [
    { id: 'counter', start: () => Counter },
    { id: 'cache', start: () => Cache }
  ],
  strategy: 'one_for_one',
  maxRestarts: 3
});`,
    registry: `// Register a process
Registry.register('user:123', userProcess);

// Find it anywhere
const user = Registry.lookup('user:123');
await user.call({ type: 'getProfile' });`
  };

  const features = $derived([
    {
      key: 'genserver' as const,
      icon: 'server',
      accent: 'primary',
      data: translations.genserver,
      code: codeSnippets.genserver,
    },
    {
      key: 'supervisor' as const,
      icon: 'shield',
      accent: 'secondary',
      data: translations.supervisor,
      code: codeSnippets.supervisor,
    },
    {
      key: 'registry' as const,
      icon: 'search',
      accent: 'primary',
      data: translations.registry,
      code: codeSnippets.registry,
    },
  ]);
</script>

<section
  bind:this={sectionRef}
  id="features"
  class="features-section snap-section bg-bg-primary"
  aria-labelledby="features-title"
>
  <!-- Background elements -->
  <div class="background-elements" aria-hidden="true">
    <div class="gradient-blob gradient-blob-1"></div>
    <div class="gradient-blob gradient-blob-2"></div>
    <div class="grid-pattern"></div>
  </div>

  <div class="content-wrapper max-w-6xl mx-auto relative z-10">
    <!-- Title with fade-in -->
    <h2
      id="features-title"
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

    <!-- Feature cards grid -->
    <div class="cards-grid grid lg:grid-cols-3 gap-6 lg:gap-8">
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
          <!-- Card header -->
          <div class="card-header">
            <!-- Icon -->
            <div class="card-icon" aria-hidden="true">
              {#if feature.icon === 'server'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
                </svg>
              {:else if feature.icon === 'shield'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
              {:else if feature.icon === 'search'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5-15H5.625c-.621 0-1.125.504-1.125 1.125v16.5c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9zm3.75 11.625a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                </svg>
              {/if}
            </div>

            <!-- Title -->
            <h3 class="card-title text-xl font-bold">
              {feature.data.title}
            </h3>
          </div>

          <!-- Description -->
          <p class="card-description text-text-secondary leading-relaxed mb-4">
            {feature.data.description}
          </p>

          <!-- Code snippet -->
          <button
            class="code-block"
            onclick={() => openCodeModal(feature.data.title, feature.code, `${feature.key}.ts`)}
            aria-label="Expand code"
            title="Click to expand"
          >
            <div class="code-header">
              <span class="code-dot code-dot-red"></span>
              <span class="code-dot code-dot-yellow"></span>
              <span class="code-dot code-dot-green"></span>
              <span class="code-filename">{feature.key}.ts</span>
              <span class="expand-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
              </span>
            </div>
            <pre class="code-content"><code>{@html highlightCode(feature.code)}</code></pre>
          </button>

          <!-- Hover glow effect -->
          <div class="card-glow" aria-hidden="true"></div>
        </article>
      {/each}
    </div>
  </div>

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
  // Simple syntax highlighting function
  function highlightCode(code: string): string {
    return code
      // Keywords
      .replace(/\b(class|extends|const|let|return|new|await|async|function|if|else)\b/g, '<span class="hl-keyword">$1</span>')
      // Types and Classes
      .replace(/\b(GenServer|Supervisor|Registry|Counter|Cache)\b/g, '<span class="hl-class">$1</span>')
      // Strings
      .replace(/'([^']+)'/g, '<span class="hl-string">\'$1\'</span>')
      // Numbers
      .replace(/\b(\d+)\b/g, '<span class="hl-number">$1</span>')
      // Methods/Functions
      .replace(/\b(init|handleCall|handleCast|register|lookup|call|start)\b/g, '<span class="hl-method">$1</span>')
      // Properties
      .replace(/\b(state|children|id|strategy|maxRestarts|type)\b(?=\s*[:\)])/g, '<span class="hl-property">$1</span>')
      // Comments
      .replace(/(\/\/[^\n]*)/g, '<span class="hl-comment">$1</span>')
      // Arrow functions
      .replace(/=&gt;/g, '<span class="hl-keyword">=&gt;</span>');
  }
</script>

<style>
  .features-section {
    position: relative;
    overflow: hidden;
  }

  /* Background effects */
  .background-elements {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .gradient-blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(120px);
    opacity: 0.12;
  }

  .gradient-blob-1 {
    width: 600px;
    height: 600px;
    background: var(--color-accent-primary);
    top: -200px;
    right: -200px;
    animation: blobFloat1 15s ease-in-out infinite;
  }

  .gradient-blob-2 {
    width: 500px;
    height: 500px;
    background: var(--color-accent-secondary);
    bottom: -200px;
    left: -200px;
    animation: blobFloat2 18s ease-in-out infinite;
  }

  .grid-pattern {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(0, 255, 136, 0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 255, 136, 0.02) 1px, transparent 1px);
    background-size: 40px 40px;
  }

  @keyframes blobFloat1 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50% { transform: translate(-40px, 30px) scale(1.05); }
  }

  @keyframes blobFloat2 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50% { transform: translate(30px, -40px) scale(1.08); }
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

  /* Feature cards */
  .feature-card {
    position: relative;
    background: rgba(26, 26, 46, 0.6);
    backdrop-filter: blur(12px);
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
  }

  .feature-card.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .feature-card:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
  }

  /* Accent-specific hover styles */
  .feature-card.accent-primary:hover,
  .feature-card.accent-primary.active {
    border-color: var(--color-accent-primary);
    box-shadow:
      0 0 40px rgba(0, 255, 136, 0.15),
      0 20px 50px rgba(0, 0, 0, 0.3);
    transform: translateY(-6px) scale(1);
  }

  .feature-card.accent-secondary:hover,
  .feature-card.accent-secondary.active {
    border-color: var(--color-accent-secondary);
    box-shadow:
      0 0 40px rgba(0, 212, 255, 0.15),
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

  /* Card icon */
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

  .feature-card:hover .card-icon,
  .feature-card.active .card-icon {
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

  /* Code block */
  .code-block {
    width: 100%;
    text-align: left;
    background: rgba(10, 10, 15, 0.8);
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

  .code-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .code-dot-red { background: #ff5f56; }
  .code-dot-yellow { background: #ffbd2e; }
  .code-dot-green { background: #27ca40; }

  .code-content {
    padding: 1rem;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.75rem;
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

  /* Card glow effect */
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
    background: linear-gradient(
      to bottom,
      rgba(0, 255, 136, 0.1),
      transparent
    );
  }

  .accent-secondary .card-glow {
    background: linear-gradient(
      to bottom,
      rgba(0, 212, 255, 0.1),
      transparent
    );
  }

  .feature-card:hover .card-glow,
  .feature-card.active .card-glow {
    opacity: 1;
  }

  /* Responsive adjustments */
  @media (max-width: 1024px) {
    .cards-grid {
      max-width: 500px;
      margin-left: auto;
      margin-right: auto;
    }
  }

  @media (max-width: 768px) {
    .feature-card {
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
      font-size: 0.7rem;
      padding: 0.75rem;
    }

    .gradient-blob-1 {
      width: 280px;
      height: 280px;
      opacity: 0.08;
    }

    .gradient-blob-2 {
      width: 220px;
      height: 220px;
      opacity: 0.08;
    }
  }

  @media (max-width: 640px) {
    .code-modal-overlay {
      padding: 0.5rem;
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
    from { opacity: 0; }
    to { opacity: 1; }
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

  /* Reduced motion support */
  @media (prefers-reduced-motion: reduce) {
    .section-title,
    .section-subtitle,
    .feature-card {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .gradient-blob-1,
    .gradient-blob-2 {
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

    .code-block:hover {
      transform: none;
    }

    .code-modal-overlay,
    .code-modal {
      animation: none;
    }
  }
</style>
