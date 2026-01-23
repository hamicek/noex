<script lang="ts">
  import { onMount } from 'svelte';
  import BitcoinDonate from '../ui/BitcoinDonate.svelte';

  interface SupportTranslations {
    title: string;
    description: string;
    btc: string;
    btcCopied: string;
  }

  interface CtaTranslations {
    title: string;
    subtitle: string;
    install: string;
    copied: string;
    steps: {
      title: string;
      install: string;
      import: string;
      run: string;
    };
    docs: string;
    github: string;
    links: {
      examples: string;
      api: string;
      contributing: string;
    };
    community: {
      title: string;
      github: string;
      discord: string;
    };
  }

  interface FooterTranslations {
    copyright: string;
    madeWith: string;
  }

  interface Props {
    translations: CtaTranslations;
    footerTranslations: FooterTranslations;
    supportTranslations: SupportTranslations;
    githubUrl?: string;
    docsUrl?: string;
    btcAddress?: string;
  }

  let {
    translations,
    footerTranslations,
    supportTranslations,
    githubUrl = 'https://github.com/hamicek/noex',
    docsUrl = 'https://github.com/hamicek/noex#readme',
    btcAddress = 'bc1qqegxqjgnyypm984kqqajyvcwcrtrrgz3z9rvc8'
  }: Props = $props();

  let sectionRef: HTMLElement | null = $state(null);
  let isVisible = $state(false);
  let copied = $state(false);

  const installCommand = 'npm install @hamicek/noex';

  const quickStartCode = `import { GenServer } from '@hamicek/noex';

class Counter extends GenServer<number> {
  init() { return 0; }

  handleCast(msg: 'inc') {
    this.state++;
  }
}

const counter = await Counter.start();`;

  onMount(() => {
    if (!sectionRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            isVisible = true;
          }
        });
      },
      { threshold: 0.2 }
    );

    observer.observe(sectionRef);

    return () => observer.disconnect();
  });

  async function copyInstallCommand() {
    try {
      await navigator.clipboard.writeText(installCommand);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = installCommand;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    }
  }

  function highlightCode(code: string): string {
    return code
      .replace(/(\/\/[^\n]*)/g, '<span class="hl-comment">$1</span>')
      .replace(/('[^']*')/g, '<span class="hl-string">$1</span>')
      .replace(/("[^"]*")/g, '<span class="hl-string">$1</span>')
      .replace(/\b(import|from|export|class|extends|const|let|return|new|await|async|function)\b/g, '<span class="hl-keyword">$1</span>')
      .replace(/\b(GenServer|Counter)\b/g, '<span class="hl-class">$1</span>')
      .replace(/\b(\d+)\b/g, '<span class="hl-number">$1</span>')
      .replace(/\b(init|handleCast|start)\b(?=\s*[\(\{])/g, '<span class="hl-method">$1</span>')
      .replace(/\b(state)\b/g, '<span class="hl-property">$1</span>');
  }
</script>

<section
  bind:this={sectionRef}
  id="cta"
  class="cta-section snap-section bg-bg-secondary"
  aria-labelledby="cta-title"
>
  <!-- Background elements -->
  <div class="background-elements" aria-hidden="true">
    <div class="gradient-blob gradient-blob-1"></div>
    <div class="gradient-blob gradient-blob-2"></div>
    <div class="grid-pattern"></div>
  </div>

  <div class="content-wrapper max-w-5xl mx-auto relative z-10 px-4">
    <!-- Title -->
    <h2
      id="cta-title"
      class="section-title text-3xl md:text-5xl font-bold mb-4 text-text-primary text-center"
      class:visible={isVisible}
    >
      {translations.title}
    </h2>

    <p
      class="section-subtitle text-lg text-text-secondary text-center mb-10 md:mb-14 max-w-2xl mx-auto"
      class:visible={isVisible}
    >
      {translations.subtitle}
    </p>

    <!-- Install Command Card -->
    <div
      class="install-card glass-card mx-auto mb-10 md:mb-14"
      class:visible={isVisible}
    >
      <div class="install-header">
        <div class="terminal-dots">
          <span class="dot dot-red"></span>
          <span class="dot dot-yellow"></span>
          <span class="dot dot-green"></span>
        </div>
        <span class="install-label">{translations.install}</span>
      </div>
      <div class="install-content">
        <code class="install-command">
          <span class="prompt">$</span> {installCommand}
        </code>
        <button
          class="copy-button"
          onclick={copyInstallCommand}
          aria-label={copied ? translations.copied : 'Copy command'}
        >
          {#if copied}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="check-icon">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <span>{translations.copied}</span>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="copy-icon">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
            </svg>
          {/if}
        </button>
      </div>
    </div>

    <!-- Quick Start Section -->
    <div
      class="quick-start-grid grid md:grid-cols-2 gap-6 md:gap-8 mb-10 md:mb-14"
      class:visible={isVisible}
    >
      <!-- Steps -->
      <div class="steps-card glass-card">
        <h3 class="steps-title">{translations.steps.title}</h3>
        <ol class="steps-list">
          <li class="step-item">
            <span class="step-number">1</span>
            <div class="step-content">
              <span class="step-label">{translations.steps.install}</span>
              <code class="step-code">npm install @hamicek/noex</code>
            </div>
          </li>
          <li class="step-item">
            <span class="step-number">2</span>
            <div class="step-content">
              <span class="step-label">{translations.steps.import}</span>
              <code class="step-code">import {'{'} GenServer {'}'} from '@hamicek/noex'</code>
            </div>
          </li>
          <li class="step-item">
            <span class="step-number">3</span>
            <div class="step-content">
              <span class="step-label">{translations.steps.run}</span>
              <code class="step-code">await Counter.start()</code>
            </div>
          </li>
        </ol>
      </div>

      <!-- Code Preview -->
      <div class="code-preview glass-card">
        <div class="code-header">
          <div class="terminal-dots">
            <span class="dot dot-red"></span>
            <span class="dot dot-yellow"></span>
            <span class="dot dot-green"></span>
          </div>
          <span class="code-filename">counter.ts</span>
        </div>
        <pre class="code-content"><code>{@html highlightCode(quickStartCode)}</code></pre>
      </div>
    </div>

    <!-- Action Buttons -->
    <div
      class="action-buttons flex flex-col sm:flex-row gap-4 justify-center mb-12 md:mb-16"
      class:visible={isVisible}
    >
      <a
        href={docsUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="btn-primary"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="btn-icon">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
        </svg>
        {translations.docs}
      </a>
      <a
        href={githubUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="btn-secondary"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" class="btn-icon">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
        </svg>
        {translations.github}
      </a>
    </div>

    <!-- Resource Links -->
    <div
      class="resource-links flex flex-wrap justify-center gap-6 mb-12 md:mb-16"
      class:visible={isVisible}
    >
      <a href={`${githubUrl}/tree/main/examples`} target="_blank" rel="noopener noreferrer" class="resource-link">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="resource-icon">
          <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
        </svg>
        {translations.links.examples}
      </a>
      <a href={`${githubUrl}/tree/main/docs/api`} target="_blank" rel="noopener noreferrer" class="resource-link">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="resource-icon">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        {translations.links.api}
      </a>
      <a href={`${githubUrl}/blob/main/docs/contributing.md`} target="_blank" rel="noopener noreferrer" class="resource-link">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="resource-icon">
          <path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
        </svg>
        {translations.links.contributing}
      </a>
    </div>

    <!-- Support Section -->
    <div
      class="support-section"
      class:visible={isVisible}
    >
      <h3 class="support-title">{supportTranslations.title}</h3>
      <p class="support-description">{supportTranslations.description}</p>

      <div class="support-options">
        <!-- Bitcoin -->
        <div class="support-card glass-card">
          <BitcoinDonate
            address={btcAddress}
            btcLabel={supportTranslations.btc}
            copiedLabel={supportTranslations.btcCopied}
          />
        </div>

      </div>
    </div>

    <!-- Footer -->
    <footer class="footer" class:visible={isVisible}>
      <div class="footer-content">
        <p class="copyright">
          {footerTranslations.copyright} · {footerTranslations.madeWith}
          <span class="heart" aria-label="love">♥</span>
        </p>
      </div>
    </footer>
  </div>
</section>

<style>
  .cta-section {
    position: relative;
    overflow: hidden;
  }

  /* Background */
  .background-elements {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .gradient-blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(120px);
    opacity: 0.08;
  }

  .gradient-blob-1 {
    width: 600px;
    height: 600px;
    background: var(--color-accent-primary);
    top: -20%;
    left: 50%;
    transform: translateX(-50%);
    animation: blobFloat1 20s ease-in-out infinite;
  }

  .gradient-blob-2 {
    width: 400px;
    height: 400px;
    background: var(--color-accent-secondary);
    bottom: -10%;
    right: -5%;
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
    0%, 100% { transform: translateX(-50%) scale(1); }
    50% { transform: translateX(-50%) scale(1.1) translateY(20px); }
  }

  @keyframes blobFloat2 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50% { transform: translate(-30px, -20px) scale(1.05); }
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
    transition: opacity 0.6s ease-out 0.1s, transform 0.6s ease-out 0.1s;
  }

  .section-subtitle.visible {
    opacity: 1;
    transform: translateY(0);
  }

  /* Glass card base */
  .glass-card {
    background: rgba(26, 26, 46, 0.6);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    backdrop-filter: blur(12px);
  }

  /* Install Card */
  .install-card {
    max-width: 500px;
    opacity: 0;
    transform: translateY(20px) scale(0.98);
    transition: opacity 0.5s ease-out 0.2s, transform 0.5s ease-out 0.2s;
  }

  .install-card.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .install-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border);
    background: rgba(18, 18, 26, 0.5);
    border-radius: 16px 16px 0 0;
  }

  .terminal-dots {
    display: flex;
    gap: 6px;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .dot-red { background: #ff5f56; }
  .dot-yellow { background: #ffbd2e; }
  .dot-green { background: #27ca40; }

  .install-label {
    font-size: 0.8rem;
    color: var(--color-text-secondary);
  }

  .install-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 24px;
    gap: 16px;
  }

  .install-command {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 1.1rem;
    color: var(--color-accent-primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .prompt {
    color: var(--color-text-secondary);
  }

  .copy-button {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: rgba(0, 255, 136, 0.1);
    border: 1px solid var(--color-accent-primary);
    border-radius: 8px;
    color: var(--color-accent-primary);
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
  }

  .copy-button:hover {
    background: rgba(0, 255, 136, 0.2);
    box-shadow: 0 0 20px rgba(0, 255, 136, 0.2);
  }

  .copy-button svg {
    width: 16px;
    height: 16px;
  }

  .copy-button .check-icon {
    color: var(--color-accent-primary);
  }

  /* Quick Start Grid */
  .quick-start-grid {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease-out 0.3s, transform 0.5s ease-out 0.3s;
  }

  .quick-start-grid.visible {
    opacity: 1;
    transform: translateY(0);
  }

  /* Steps Card */
  .steps-card {
    padding: 24px;
  }

  .steps-title {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 20px;
  }

  .steps-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .step-item {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }

  .step-number {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: rgba(0, 255, 136, 0.15);
    border: 1px solid var(--color-accent-primary);
    border-radius: 50%;
    color: var(--color-accent-primary);
    font-size: 0.85rem;
    font-weight: 600;
    flex-shrink: 0;
  }

  .step-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .step-label {
    font-size: 0.9rem;
    color: var(--color-text-primary);
    font-weight: 500;
  }

  .step-code {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    background: rgba(10, 10, 15, 0.5);
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid rgba(42, 42, 62, 0.5);
  }

  /* Code Preview */
  .code-preview {
    overflow: hidden;
  }

  .code-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border);
    background: rgba(18, 18, 26, 0.5);
  }

  .code-filename {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    color: var(--color-text-secondary);
  }

  .code-content {
    padding: 16px;
    margin: 0;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.75rem;
    line-height: 1.7;
    color: var(--color-text-secondary);
    overflow-x: auto;
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

  /* Action Buttons */
  .action-buttons {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease-out 0.4s, transform 0.5s ease-out 0.4s;
  }

  .action-buttons.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .btn-primary,
  .btn-secondary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 14px 28px;
    font-size: 1rem;
    font-weight: 600;
    border-radius: 10px;
    text-decoration: none;
    transition: all 0.3s ease;
  }

  .btn-icon {
    width: 20px;
    height: 20px;
  }

  .btn-primary {
    background: var(--color-accent-primary);
    color: var(--color-bg-primary);
    box-shadow: 0 0 25px rgba(0, 255, 136, 0.3);
  }

  .btn-primary:hover {
    box-shadow: 0 0 40px rgba(0, 255, 136, 0.5);
    transform: translateY(-2px);
  }

  .btn-secondary {
    background: transparent;
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
  }

  .btn-secondary:hover {
    border-color: var(--color-accent-secondary);
    color: var(--color-accent-secondary);
    box-shadow: 0 0 20px rgba(0, 212, 255, 0.2);
    transform: translateY(-2px);
  }

  /* Resource Links */
  .resource-links {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease-out 0.5s, transform 0.5s ease-out 0.5s;
  }

  .resource-links.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .resource-link {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--color-text-secondary);
    text-decoration: none;
    font-size: 0.9rem;
    padding: 8px 16px;
    border-radius: 8px;
    transition: all 0.2s ease;
  }

  .resource-link:hover {
    color: var(--color-accent-primary);
    background: rgba(0, 255, 136, 0.05);
  }

  .resource-icon {
    width: 18px;
    height: 18px;
  }

  /* Support Section */
  .support-section {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease-out 0.55s, transform 0.5s ease-out 0.55s;
    margin-bottom: 48px;
    text-align: center;
  }

  .support-section.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .support-title {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 8px;
  }

  .support-description {
    font-size: 1rem;
    color: var(--color-text-secondary);
    margin-bottom: 24px;
  }

  .support-options {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    max-width: 400px;
    margin: 0 auto;
  }

  .support-card {
    width: 100%;
  }

  /* Footer */
  .footer {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease-out 0.65s, transform 0.5s ease-out 0.65s;
    padding-top: 24px;
    border-top: 1px solid var(--color-border);
  }

  .footer.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .footer-content {
    text-align: center;
  }

  .copyright {
    color: var(--color-text-secondary);
    font-size: 0.85rem;
  }

  .heart {
    color: var(--color-accent-tertiary);
    animation: heartbeat 1.5s ease-in-out infinite;
  }

  @keyframes heartbeat {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.1); }
  }

  /* Responsive */
  @media (max-width: 768px) {
    .install-content {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
    }

    .install-command {
      font-size: 0.95rem;
      justify-content: center;
    }

    .copy-button {
      justify-content: center;
    }

    .steps-card,
    .code-preview {
      padding: 20px;
    }

    .code-content {
      font-size: 0.7rem;
    }

    .btn-primary,
    .btn-secondary {
      width: 100%;
    }

    .gradient-blob-1,
    .gradient-blob-2 {
      opacity: 0.05;
    }

    .support-title {
      font-size: 1.25rem;
    }

    .support-description {
      font-size: 0.9rem;
    }
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .section-title,
    .section-subtitle,
    .install-card,
    .quick-start-grid,
    .action-buttons,
    .resource-links,
    .support-section,
    .footer {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .gradient-blob-1,
    .gradient-blob-2 {
      animation: none;
    }

    .heart {
      animation: none;
    }
  }
</style>
