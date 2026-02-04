<script lang="ts">
  import { onMount } from 'svelte';

  interface Pattern {
    title: string;
    description: string;
  }

  interface PatternsTranslations {
    title: string;
    subtitle: string;
    genStateMachine: Pattern;
    agent: Pattern;
    task: Pattern;
  }

  interface Props {
    translations: PatternsTranslations;
  }

  let { translations }: Props = $props();

  let sectionRef: HTMLElement | null = $state(null);
  let isVisible = $state(false);
  let cardsVisible = $state([false, false, false]);
  let activeCard = $state<number | null>(null);
  let expandedCode = $state<{ title: string; code: string; filename: string } | null>(null);

  onMount(() => {
    if (!sectionRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            isVisible = true;
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

  const codeSnippets = {
    genStateMachine: `const trafficLight: StateMachineBehavior<
  'red' | 'green' | 'yellow',
  TimerEvent
> = {
  init: () => ({ state: 'red', data: null }),
  states: {
    red: {
      handleEvent: (event) =>
        event.type === 'timer'
          ? { type: 'transition', nextState: 'green' }
          : { type: 'keep_state_and_data' }
    },
    green: { /* timer -> yellow */ },
    yellow: { /* timer -> red */ }
  }
};`,
    agent: `// Simple state container
const counter = await Agent.start(() => 0);

await Agent.update(counter, n => n + 1);
await Agent.update(counter, n => n + 1);

const value = await Agent.get(counter, n => n);
// value === 2`,
    task: `const supervisor = await Task.Supervisor.start();

// Concurrent execution with limit
const results = await Task.Supervisor.asyncStream(
  supervisor,
  urls.map(url => () => fetch(url).then(r => r.json())),
  { concurrency: 3 }
);`
  };

  const patterns = $derived([
    {
      key: 'genStateMachine' as const,
      icon: 'state',
      accent: 'secondary',
      data: translations.genStateMachine,
      code: codeSnippets.genStateMachine,
      useCases: ['Workflows', 'Protocols', 'Game logic']
    },
    {
      key: 'agent' as const,
      icon: 'box',
      accent: 'primary',
      data: translations.agent,
      code: codeSnippets.agent,
      useCases: ['Counters', 'Accumulators', 'Simple state']
    },
    {
      key: 'task' as const,
      icon: 'tasks',
      accent: 'secondary',
      data: translations.task,
      code: codeSnippets.task,
      useCases: ['Batch processing', 'Parallel I/O', 'Job queues']
    }
  ]);
</script>

<section
  bind:this={sectionRef}
  id="patterns"
  class="patterns-section snap-section bg-bg-primary"
  aria-labelledby="patterns-title"
>
  <div class="background-elements" aria-hidden="true">
    <div class="gradient-blob gradient-blob-1"></div>
    <div class="gradient-blob gradient-blob-2"></div>
    <div class="hex-pattern"></div>
  </div>

  <div class="content-wrapper max-w-6xl mx-auto relative z-10">
    <h2
      id="patterns-title"
      class="section-title text-3xl md:text-5xl font-bold mb-4 text-text-primary text-center"
      class:visible={isVisible}
    >
      {translations.title}
    </h2>

    <p
      class="section-subtitle text-lg text-text-secondary text-center mb-12 md:mb-16 max-w-2xl mx-auto"
      class:visible={isVisible}
    >
      {translations.subtitle}
    </p>

    <div class="cards-grid grid lg:grid-cols-3 gap-6 lg:gap-8">
      {#each patterns as pattern, index}
        <article
          class="pattern-card"
          class:visible={cardsVisible[index]}
          class:active={activeCard === index}
          class:accent-primary={pattern.accent === 'primary'}
          class:accent-secondary={pattern.accent === 'secondary'}
          onmouseenter={() => (activeCard = index)}
          onmouseleave={() => (activeCard = null)}
          onfocus={() => (activeCard = index)}
          onblur={() => (activeCard = null)}
          role="article"
          tabindex="0"
        >
          <div class="card-header">
            <div class="card-icon" aria-hidden="true">
              {#if pattern.icon === 'state'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <circle cx="6" cy="6" r="3" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="12" cy="18" r="3" />
                  <path d="M8.5 7.5L10.5 16" />
                  <path d="M15.5 7.5L13.5 16" />
                  <path d="M9 6h6" />
                </svg>
              {:else if pattern.icon === 'box'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                  <path d="m3.3 7 8.7 5 8.7-5" />
                  <path d="M12 22V12" />
                </svg>
              {:else if pattern.icon === 'tasks'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M16 3h5v5" />
                  <path d="M8 3H3v5" />
                  <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872l-3.535-3.535" />
                  <path d="m15 9 6-6" />
                  <path d="m16 16 5 5" />
                  <path d="M21 21v-5h-5" />
                </svg>
              {/if}
            </div>
            <h3 class="card-title text-xl font-bold">
              {pattern.data.title}
            </h3>
          </div>

          <p class="card-description text-text-secondary leading-relaxed mb-4">
            {pattern.data.description}
          </p>

          <div class="use-cases mb-4">
            {#each pattern.useCases as useCase}
              <span class="use-case-tag">{useCase}</span>
            {/each}
          </div>

          <button
            class="code-block"
            onclick={() => openCodeModal(pattern.data.title, pattern.code, `${pattern.key}.ts`)}
            aria-label="Expand code"
            title="Click to expand"
          >
            <div class="code-header">
              <span class="code-dot code-dot-red"></span>
              <span class="code-dot code-dot-yellow"></span>
              <span class="code-dot code-dot-green"></span>
              <span class="code-filename">{pattern.key}.ts</span>
              <span class="expand-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
              </span>
            </div>
            <pre class="code-content"><code>{@html highlightCode(pattern.code)}</code></pre>
          </button>

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
  function highlightCode(code: string): string {
    return code
      .replace(/\b(const|let|await|async|return|type)\b/g, '<span class="hl-keyword">$1</span>')
      .replace(/\b(StateMachineBehavior|Agent|Task|Supervisor)\b/g, '<span class="hl-class">$1</span>')
      .replace(/\b(init|handleEvent|start|update|get|asyncStream|fetch|then|map)\b/g, '<span class="hl-method">$1</span>')
      .replace(/'([^']+)'/g, '<span class="hl-string">\'$1\'</span>')
      .replace(/\b(\d+)\b/g, '<span class="hl-number">$1</span>')
      .replace(/\b(state|data|states|type|nextState|concurrency)\b(?=\s*[:\)])/g, '<span class="hl-property">$1</span>')
      .replace(/(\/\/[^\n]*)/g, '<span class="hl-comment">$1</span>')
      .replace(/\/\*[^*]*\*\//g, '<span class="hl-comment">$&</span>')
      .replace(/=&gt;/g, '<span class="hl-keyword">=&gt;</span>');
  }
</script>

<style>
  .patterns-section {
    position: relative;
    overflow: hidden;
  }

  .background-elements {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .gradient-blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(120px);
    opacity: 0.1;
  }

  .gradient-blob-1 {
    width: 550px;
    height: 550px;
    background: var(--color-accent-secondary);
    top: -180px;
    right: -180px;
    animation: blobDrift1 18s ease-in-out infinite;
  }

  .gradient-blob-2 {
    width: 450px;
    height: 450px;
    background: var(--color-accent-primary);
    bottom: -150px;
    left: -150px;
    animation: blobDrift2 22s ease-in-out infinite;
  }

  .hex-pattern {
    position: absolute;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='49' viewBox='0 0 28 49'%3E%3Cpath fill='%2300d4ff' fill-opacity='0.03' d='M13.99 9.25l13 7.5v15l-13 7.5L1 31.75v-15l12.99-7.5zM3 17.9v12.7l10.99 6.34 11-6.35V17.9l-11-6.34L3 17.9z'/%3E%3C/svg%3E");
  }

  @keyframes blobDrift1 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50% { transform: translate(-30px, 40px) scale(1.06); }
  }

  @keyframes blobDrift2 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50% { transform: translate(40px, -30px) scale(1.04); }
  }

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

  .pattern-card {
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

  .pattern-card.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .pattern-card:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
  }

  .pattern-card.accent-primary:hover,
  .pattern-card.accent-primary.active {
    border-color: var(--color-accent-primary);
    box-shadow:
      0 0 40px rgba(0, 255, 136, 0.12),
      0 20px 50px rgba(0, 0, 0, 0.3);
    transform: translateY(-6px) scale(1);
  }

  .pattern-card.accent-secondary:hover,
  .pattern-card.accent-secondary.active {
    border-color: var(--color-accent-secondary);
    box-shadow:
      0 0 40px rgba(0, 212, 255, 0.12),
      0 20px 50px rgba(0, 0, 0, 0.3);
    transform: translateY(-6px) scale(1);
  }

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

  .pattern-card:hover .card-icon,
  .pattern-card.active .card-icon {
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
    font-size: 0.65rem;
    line-height: 1.5;
    overflow-x: auto;
    margin: 0;
    color: var(--color-text-secondary);
  }

  .code-content code {
    display: block;
    white-space: pre;
  }

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

  .pattern-card:hover .card-glow,
  .pattern-card.active .card-glow {
    opacity: 1;
  }

  @media (max-width: 1024px) {
    .cards-grid {
      max-width: 500px;
      margin-left: auto;
      margin-right: auto;
    }
  }

  @media (max-width: 768px) {
    .pattern-card {
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
      font-size: 0.6rem;
      padding: 0.75rem;
    }

    .gradient-blob-1 {
      width: 300px;
      height: 300px;
      opacity: 0.06;
    }

    .gradient-blob-2 {
      width: 250px;
      height: 250px;
      opacity: 0.06;
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

  @media (prefers-reduced-motion: reduce) {
    .section-title,
    .section-subtitle,
    .pattern-card {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .gradient-blob-1,
    .gradient-blob-2 {
      animation: none;
    }

    .pattern-card:hover,
    .pattern-card.active {
      transform: none;
    }

    .pattern-card:hover .card-icon,
    .pattern-card.active .card-icon {
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
