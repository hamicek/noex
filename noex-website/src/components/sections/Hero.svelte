<script lang="ts">
  import { onMount } from 'svelte';

  interface HeroTranslations {
    headline: string;
    subheadline: string;
    cta: {
      getStarted: string;
      viewGithub: string;
    };
    scrollDown: string;
  }

  interface Props {
    translations: HeroTranslations;
    githubUrl?: string;
  }

  let { translations, githubUrl = 'https://github.com/hamicek/noex' }: Props = $props();

  // TypeWriter effect state
  let displayedHeadline = $state('');
  let showCursor = $state(true);
  let typingComplete = $state(false);

  // Typewriter animation
  onMount(() => {
    const headline = translations.headline;
    let currentIndex = 0;
    const typingSpeed = 50; // ms per character

    const typeInterval = setInterval(() => {
      if (currentIndex <= headline.length) {
        displayedHeadline = headline.slice(0, currentIndex);
        currentIndex++;
      } else {
        clearInterval(typeInterval);
        typingComplete = true;
        // Blink cursor after typing is done
        setTimeout(() => {
          showCursor = false;
        }, 2000);
      }
    }, typingSpeed);

    // Cursor blink animation
    const cursorInterval = setInterval(() => {
      if (typingComplete) {
        showCursor = !showCursor;
      }
    }, 530);

    return () => {
      clearInterval(typeInterval);
      clearInterval(cursorInterval);
    };
  });

  function scrollToFeatures() {
    const featuresSection = document.getElementById('features');
    if (featuresSection) {
      featuresSection.scrollIntoView({ behavior: 'smooth' });
    }
  }
</script>

<section id="hero" class="hero-section snap-section bg-bg-primary">
  <!-- Animated Grid Background -->
  <div class="grid-background" aria-hidden="true">
    <div class="grid-overlay"></div>
    <div class="glow-orb glow-orb-1"></div>
    <div class="glow-orb glow-orb-2"></div>
  </div>

  <!-- Floating Code Snippet Background -->
  <div class="code-background" aria-hidden="true">
    <pre class="floating-code"><code><span class="code-keyword">class</span> <span class="code-class">Counter</span> <span class="code-keyword">extends</span> <span class="code-class">GenServer</span>&lt;<span class="code-type">number</span>&gt; {'{'}</code>
<code>  <span class="code-method">init</span>() {'{'} <span class="code-keyword">return</span> <span class="code-number">0</span>; {'}'}</code>
<code></code>
<code>  <span class="code-method">handleCall</span>(<span class="code-param">msg</span>: <span class="code-string">'get'</span>) {'{'}</code>
<code>    <span class="code-keyword">return</span> <span class="code-keyword">this</span>.state;</code>
<code>  {'}'}</code>
<code>{'}'}</code></pre>
  </div>

  <!-- Main Content -->
  <div class="hero-content max-w-4xl mx-auto text-center relative z-10">
    <!-- Logo -->
    <h1 class="text-5xl md:text-7xl font-bold mb-6">
      <span class="logo-text">noex</span>
    </h1>

    <!-- Headline with TypeWriter Effect -->
    <p class="headline text-2xl md:text-4xl font-semibold mb-4 text-text-primary">
      {displayedHeadline}<span class="cursor" class:visible={showCursor}>|</span>
    </p>

    <!-- Subheadline -->
    <p class="subheadline text-lg md:text-xl text-text-secondary mb-8 max-w-2xl mx-auto">
      {translations.subheadline}
    </p>

    <!-- CTA Buttons -->
    <div class="cta-buttons flex flex-col sm:flex-row gap-4 justify-center">
      <a
        href="#features"
        class="cta-primary px-8 py-3 bg-accent-primary text-bg-primary font-semibold rounded-lg transition-all"
        onclick={(e) => { e.preventDefault(); scrollToFeatures(); }}
      >
        {translations.cta.getStarted}
      </a>
      <a
        href={githubUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="cta-secondary px-8 py-3 border border-border text-text-primary rounded-lg hover:border-accent-secondary hover:text-accent-secondary transition-all"
      >
        {translations.cta.viewGithub}
      </a>
    </div>
  </div>

  <!-- Scroll Down Indicator -->
  <button
    type="button"
    class="scroll-indicator absolute bottom-8 left-1/2 -translate-x-1/2"
    onclick={scrollToFeatures}
    aria-label={translations.scrollDown}
  >
    <svg
      class="w-6 h-6 text-text-secondary"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M19 14l-7 7m0 0l-7-7m7 7V3"
      />
    </svg>
  </button>
</section>

<style>
  .hero-section {
    position: relative;
    overflow: hidden;
  }

  /* Animated Grid Background */
  .grid-background {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .grid-overlay {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(0, 255, 136, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 255, 136, 0.03) 1px, transparent 1px);
    background-size: 60px 60px;
    animation: gridPulse 4s ease-in-out infinite;
  }

  @keyframes gridPulse {
    0%, 100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }

  /* Glowing Orbs */
  .glow-orb {
    position: absolute;
    border-radius: 50%;
    filter: blur(80px);
    opacity: 0.4;
  }

  .glow-orb-1 {
    width: 400px;
    height: 400px;
    background: var(--color-accent-primary);
    top: -100px;
    right: -100px;
    animation: orbFloat1 8s ease-in-out infinite;
  }

  .glow-orb-2 {
    width: 300px;
    height: 300px;
    background: var(--color-accent-secondary);
    bottom: -50px;
    left: -50px;
    animation: orbFloat2 10s ease-in-out infinite;
  }

  @keyframes orbFloat1 {
    0%, 100% {
      transform: translate(0, 0) scale(1);
    }
    50% {
      transform: translate(-30px, 30px) scale(1.1);
    }
  }

  @keyframes orbFloat2 {
    0%, 100% {
      transform: translate(0, 0) scale(1);
    }
    50% {
      transform: translate(20px, -20px) scale(1.05);
    }
  }

  /* Floating Code Background */
  .code-background {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    opacity: 0.06;
  }

  .floating-code {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: clamp(0.7rem, 2vw, 1.2rem);
    line-height: 1.8;
    white-space: pre;
    animation: codeFloat 6s ease-in-out infinite;
  }

  .floating-code code {
    display: block;
  }

  @keyframes codeFloat {
    0%, 100% {
      transform: translateY(0) rotate(-2deg);
    }
    50% {
      transform: translateY(-10px) rotate(2deg);
    }
  }

  /* Code Syntax Colors (subtle in background) */
  .code-keyword { color: var(--color-accent-secondary); }
  .code-class { color: var(--color-accent-primary); }
  .code-method { color: var(--color-text-primary); }
  .code-type { color: var(--color-accent-secondary); }
  .code-string { color: var(--color-accent-primary); }
  .code-number { color: var(--color-accent-tertiary); }
  .code-param { color: var(--color-text-secondary); }

  /* Logo Styling */
  .logo-text {
    color: var(--color-accent-primary);
    text-shadow: 0 0 40px rgba(0, 255, 136, 0.5);
  }

  /* TypeWriter Cursor */
  .cursor {
    color: var(--color-accent-primary);
    font-weight: 300;
    opacity: 0;
    transition: opacity 0.1s;
  }

  .cursor.visible {
    opacity: 1;
  }

  /* Content Animation */
  .hero-content {
    animation: fadeInUp 0.8s ease-out;
  }

  @keyframes fadeInUp {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* CTA Primary Button */
  .cta-primary {
    box-shadow: 0 0 20px rgba(0, 255, 136, 0.3);
    position: relative;
    overflow: hidden;
  }

  .cta-primary::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      135deg,
      transparent 0%,
      rgba(255, 255, 255, 0.1) 50%,
      transparent 100%
    );
    transform: translateX(-100%);
    transition: transform 0.5s ease;
  }

  .cta-primary:hover {
    box-shadow: 0 0 30px rgba(0, 255, 136, 0.5);
    transform: translateY(-2px);
  }

  .cta-primary:hover::before {
    transform: translateX(100%);
  }

  /* CTA Secondary Button */
  .cta-secondary:hover {
    transform: translateY(-2px);
    box-shadow: 0 0 20px rgba(0, 212, 255, 0.2);
  }

  /* Scroll Indicator */
  .scroll-indicator {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0.5rem;
    animation: bounce 2s infinite;
    transition: color 0.2s ease;
  }

  .scroll-indicator:hover {
    color: var(--color-accent-primary);
  }

  .scroll-indicator:focus {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  @keyframes bounce {
    0%, 20%, 50%, 80%, 100% {
      transform: translateX(-50%) translateY(0);
    }
    40% {
      transform: translateX(-50%) translateY(-10px);
    }
    60% {
      transform: translateX(-50%) translateY(-5px);
    }
  }

  /* Responsive adjustments */
  @media (max-width: 768px) {
    .glow-orb-1 {
      width: 250px;
      height: 250px;
    }

    .glow-orb-2 {
      width: 200px;
      height: 200px;
    }

    .code-background {
      opacity: 0.04;
    }
  }

  /* Reduced motion support */
  @media (prefers-reduced-motion: reduce) {
    .grid-overlay,
    .glow-orb,
    .floating-code,
    .hero-content,
    .scroll-indicator {
      animation: none;
    }

    .cta-primary::before {
      display: none;
    }

    .cta-primary:hover,
    .cta-secondary:hover {
      transform: none;
    }
  }
</style>
