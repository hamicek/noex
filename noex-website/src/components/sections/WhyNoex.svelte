<script lang="ts">
  import { onMount } from 'svelte';

  interface Benefit {
    title: string;
    description: string;
  }

  interface WhyNoexTranslations {
    title: string;
    subtitle: string;
    tagline: string;
    benefits: {
      proven: Benefit;
      faultTolerant: Benefit;
      distributed: Benefit;
      observable: Benefit;
    };
    learnMore: string;
  }

  interface Props {
    translations: WhyNoexTranslations;
  }

  let { translations }: Props = $props();

  let sectionRef: HTMLElement | null = $state(null);
  let isVisible = $state(false);
  let cardsVisible = $state([false, false, false, false]);

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
              }, 150 * (index + 1));
            });
          }
        });
      },
      { threshold: 0.15 }
    );

    observer.observe(sectionRef);

    return () => {
      observer.disconnect();
    };
  });

  const benefits = $derived([
    {
      key: 'proven',
      icon: 'shield',
      data: translations.benefits.proven,
    },
    {
      key: 'faultTolerant',
      icon: 'refresh',
      data: translations.benefits.faultTolerant,
    },
    {
      key: 'distributed',
      icon: 'network',
      data: translations.benefits.distributed,
    },
    {
      key: 'observable',
      icon: 'chart',
      data: translations.benefits.observable,
    },
  ]);
</script>

<section
  id="why-noex"
  bind:this={sectionRef}
  class="why-section snap-section bg-bg-primary"
  aria-labelledby="why-title"
>
  <!-- Background effects -->
  <div class="background-effects" aria-hidden="true">
    <div class="grid-overlay"></div>
    <div class="glow-orb glow-primary"></div>
    <div class="glow-orb glow-secondary"></div>
  </div>

  <div class="content-wrapper max-w-5xl mx-auto relative z-10 px-6">
    <!-- Tagline badge -->
    <div class="tagline-badge" class:visible={isVisible}>
      <span class="badge-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
        </svg>
      </span>
      {translations.tagline}
    </div>

    <!-- Title -->
    <h2
      id="why-title"
      class="section-title text-3xl md:text-5xl font-bold mb-4 text-text-primary text-center"
      class:visible={isVisible}
    >
      {translations.title}
    </h2>

    <!-- Subtitle -->
    <p
      class="section-subtitle text-lg md:text-xl text-text-secondary text-center mb-12 max-w-3xl mx-auto"
      class:visible={isVisible}
    >
      {translations.subtitle}
    </p>

    <!-- Benefits grid -->
    <div class="benefits-grid">
      {#each benefits as benefit, index}
        <article
          class="benefit-card"
          class:visible={cardsVisible[index]}
        >
          <!-- Icon -->
          <div class="card-icon" aria-hidden="true">
            {#if benefit.icon === 'shield'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
            {:else if benefit.icon === 'refresh'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
            {:else if benefit.icon === 'network'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                <circle cx="12" cy="12" r="2" />
              </svg>
            {:else if benefit.icon === 'chart'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
              </svg>
            {/if}
          </div>

          <!-- Content -->
          <h3 class="card-title text-xl font-semibold mb-3">
            {benefit.data.title}
          </h3>
          <p class="card-description text-text-secondary leading-relaxed">
            {benefit.data.description}
          </p>

          <!-- Hover glow -->
          <div class="card-glow" aria-hidden="true"></div>
        </article>
      {/each}
    </div>

    <!-- Learn more hint -->
    <div class="learn-more" class:visible={cardsVisible[3]}>
      <div class="hint-line"></div>
      <p class="hint-text">
        <span class="hint-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
          </svg>
        </span>
        {translations.learnMore}
      </p>
    </div>
  </div>
</section>

<style>
  .why-section {
    position: relative;
    overflow: hidden;
  }

  /* Background effects */
  .background-effects {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .grid-overlay {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(0, 255, 136, 0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 255, 136, 0.02) 1px, transparent 1px);
    background-size: 80px 80px;
  }

  .glow-orb {
    position: absolute;
    border-radius: 50%;
    filter: blur(120px);
    opacity: 0.2;
  }

  .glow-primary {
    width: 500px;
    height: 500px;
    background: var(--color-accent-primary);
    top: -150px;
    left: 50%;
    transform: translateX(-50%);
    animation: orbPulse 8s ease-in-out infinite;
  }

  .glow-secondary {
    width: 300px;
    height: 300px;
    background: var(--color-accent-secondary);
    bottom: -100px;
    right: 10%;
    animation: orbPulse 10s ease-in-out infinite reverse;
  }

  @keyframes orbPulse {
    0%, 100% { opacity: 0.15; transform: translateX(-50%) scale(1); }
    50% { opacity: 0.25; transform: translateX(-50%) scale(1.1); }
  }

  /* Tagline badge */
  .tagline-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(0, 255, 136, 0.1);
    border: 1px solid rgba(0, 255, 136, 0.3);
    border-radius: 2rem;
    padding: 0.5rem 1.25rem;
    font-size: 0.875rem;
    color: var(--color-accent-primary);
    margin: 0 auto 1.5rem;
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease, transform 0.5s ease;
  }

  .tagline-badge.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .badge-icon {
    display: flex;
  }

  .badge-icon svg {
    width: 18px;
    height: 18px;
  }

  /* Title & subtitle animations */
  .section-title {
    opacity: 0;
    transform: translateY(30px);
    transition: opacity 0.6s ease-out 0.1s, transform 0.6s ease-out 0.1s;
  }

  .section-title.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .section-subtitle {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.6s ease-out 0.2s, transform 0.6s ease-out 0.2s;
  }

  .section-subtitle.visible {
    opacity: 1;
    transform: translateY(0);
  }

  /* Benefits grid */
  .benefits-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1.5rem;
  }

  @media (max-width: 768px) {
    .benefits-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Benefit cards */
  .benefit-card {
    position: relative;
    background: rgba(18, 18, 26, 0.8);
    backdrop-filter: blur(12px);
    border: 1px solid var(--color-border);
    border-radius: 1rem;
    padding: 2rem;
    opacity: 0;
    transform: translateY(30px);
    transition:
      opacity 0.5s ease-out,
      transform 0.5s ease-out,
      border-color 0.3s ease,
      box-shadow 0.3s ease;
    overflow: hidden;
  }

  .benefit-card.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .benefit-card:hover {
    border-color: var(--color-accent-primary);
    box-shadow:
      0 0 30px rgba(0, 255, 136, 0.1),
      0 10px 40px rgba(0, 0, 0, 0.2);
    transform: translateY(-4px);
  }

  /* Card icon */
  .card-icon {
    width: 52px;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.15), rgba(0, 212, 255, 0.1));
    border-radius: 12px;
    color: var(--color-accent-primary);
    margin-bottom: 1.25rem;
    transition: transform 0.3s ease, background 0.3s ease;
  }

  .card-icon svg {
    width: 26px;
    height: 26px;
  }

  .benefit-card:hover .card-icon {
    transform: scale(1.1);
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.25), rgba(0, 212, 255, 0.15));
  }

  /* Card title */
  .card-title {
    color: var(--color-text-primary);
    transition: color 0.3s ease;
  }

  .benefit-card:hover .card-title {
    color: var(--color-accent-primary);
  }

  /* Card glow effect */
  .card-glow {
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: radial-gradient(
      circle at center,
      rgba(0, 255, 136, 0.05) 0%,
      transparent 50%
    );
    opacity: 0;
    transition: opacity 0.3s ease;
    pointer-events: none;
  }

  .benefit-card:hover .card-glow {
    opacity: 1;
  }

  /* Learn more hint */
  .learn-more {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 3rem;
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.6s ease-out 0.5s, transform 0.6s ease-out 0.5s;
  }

  .learn-more.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .hint-line {
    width: 2px;
    height: 40px;
    background: linear-gradient(
      to bottom,
      transparent,
      var(--color-accent-primary)
    );
    margin-bottom: 1rem;
  }

  .hint-text {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-text-secondary);
    font-size: 1rem;
  }

  .hint-icon {
    display: flex;
    color: var(--color-accent-primary);
    animation: bounceDown 2s ease-in-out infinite;
  }

  .hint-icon svg {
    width: 20px;
    height: 20px;
  }

  @keyframes bounceDown {
    0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
    40% { transform: translateY(6px); }
    60% { transform: translateY(3px); }
  }

  /* Content wrapper - center tagline */
  .content-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .benefit-card {
    text-align: left;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .benefit-card {
      padding: 1.5rem;
    }

    .card-icon {
      width: 44px;
      height: 44px;
    }

    .card-icon svg {
      width: 22px;
      height: 22px;
    }

    .glow-primary {
      width: 280px;
      height: 280px;
      opacity: 0.1;
    }

    .glow-secondary {
      width: 180px;
      height: 180px;
      opacity: 0.1;
    }
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .tagline-badge,
    .section-title,
    .section-subtitle,
    .benefit-card,
    .learn-more {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .glow-primary,
    .glow-secondary {
      animation: none;
    }

    .hint-icon {
      animation: none;
    }

    .benefit-card:hover {
      transform: none;
    }

    .benefit-card:hover .card-icon {
      transform: none;
    }
  }
</style>
