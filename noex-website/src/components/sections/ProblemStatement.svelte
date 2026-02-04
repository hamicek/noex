<script lang="ts">
  import { onMount } from 'svelte';

  interface Issue {
    title: string;
    description: string;
  }

  interface ProblemTranslations {
    title: string;
    subtitle: string;
    solvesThese: string;
    issues: {
      raceConditions: Issue;
      errorHandling: Issue;
      scaling: Issue;
    };
  }

  interface Props {
    translations: ProblemTranslations;
  }

  let { translations }: Props = $props();

  // Intersection Observer for fade-in animations
  let sectionRef: HTMLElement | null = $state(null);
  let isVisible = $state(false);
  let cardsVisible = $state([false, false, false]);

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
              }, 150 * (index + 1));
            });
          }
        });
      },
      { threshold: 0.2 }
    );

    sectionObserver.observe(sectionRef);

    return () => {
      sectionObserver.disconnect();
    };
  });

  const issues = $derived([
    {
      key: 'raceConditions',
      icon: 'race',
      data: translations.issues.raceConditions,
    },
    {
      key: 'errorHandling',
      icon: 'cascade',
      data: translations.issues.errorHandling,
    },
    {
      key: 'scaling',
      icon: 'scaling',
      data: translations.issues.scaling,
    },
  ]);
</script>

<section
  id="problem"
  bind:this={sectionRef}
  class="problem-section snap-section bg-bg-secondary"
  aria-labelledby="problem-title"
>
  <!-- Subtle background pattern -->
  <div class="background-pattern" aria-hidden="true">
    <div class="noise-overlay"></div>
    <div class="gradient-blob gradient-blob-1"></div>
    <div class="gradient-blob gradient-blob-2"></div>
  </div>

  <div class="content-wrapper max-w-5xl mx-auto relative z-10">
    <!-- Title with fade-in -->
    <h2
      id="problem-title"
      class="section-title text-3xl md:text-5xl font-bold mb-4 text-text-primary text-center"
      class:visible={isVisible}
    >
      {translations.title}
    </h2>

    <!-- Subtitle hint -->
    <p
      class="section-subtitle text-lg text-text-secondary text-center mb-12 max-w-2xl mx-auto"
      class:visible={isVisible}
    >
      {translations.subtitle}
    </p>

    <!-- Problem cards grid -->
    <div class="cards-grid grid md:grid-cols-3 gap-6 md:gap-8">
      {#each issues as issue, index}
        <article
          class="problem-card"
          class:visible={cardsVisible[index]}
          style="--delay: {index * 0.1}s"
        >
          <!-- Icon -->
          <div class="card-icon" aria-hidden="true">
            {#if issue.icon === 'race'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
              </svg>
            {:else if issue.icon === 'cascade'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
            {:else if issue.icon === 'scaling'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
              </svg>
            {/if}
          </div>

          <!-- Content -->
          <h3 class="card-title text-xl font-semibold mb-3">
            {issue.data.title}
          </h3>
          <p class="card-description text-text-secondary leading-relaxed">
            {issue.data.description}
          </p>

          <!-- Decorative corner accent -->
          <div class="card-accent" aria-hidden="true"></div>
        </article>
      {/each}
    </div>

    <!-- Transition hint to solution -->
    <div class="solution-hint" class:visible={cardsVisible[2]}>
      <div class="hint-line"></div>
      <p class="hint-text">
        <span class="hint-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
          </svg>
        </span>
        <span class="text-accent-primary font-semibold">noex</span> {translations.solvesThese}
      </p>
    </div>
  </div>
</section>

<style>
  .problem-section {
    position: relative;
    overflow: hidden;
  }

  /* Background effects */
  .background-pattern {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .noise-overlay {
    position: absolute;
    inset: 0;
    opacity: 0.03;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
  }

  .gradient-blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(100px);
    opacity: 0.15;
  }

  .gradient-blob-1 {
    width: 500px;
    height: 500px;
    background: var(--color-accent-tertiary);
    top: -200px;
    left: -150px;
    animation: blobFloat1 12s ease-in-out infinite;
  }

  .gradient-blob-2 {
    width: 400px;
    height: 400px;
    background: var(--color-accent-secondary);
    bottom: -150px;
    right: -100px;
    animation: blobFloat2 15s ease-in-out infinite;
  }

  @keyframes blobFloat1 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50% { transform: translate(30px, 20px) scale(1.05); }
  }

  @keyframes blobFloat2 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50% { transform: translate(-20px, -30px) scale(1.08); }
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

  /* Problem cards */
  .problem-card {
    position: relative;
    background: rgba(26, 26, 46, 0.7);
    backdrop-filter: blur(12px);
    border: 1px solid var(--color-border);
    border-radius: 1rem;
    padding: 2rem;
    text-align: center;
    opacity: 0;
    transform: translateY(40px) scale(0.95);
    transition:
      opacity 0.5s ease-out,
      transform 0.5s ease-out,
      border-color 0.3s ease,
      box-shadow 0.3s ease;
    overflow: hidden;
  }

  .problem-card.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .problem-card:hover {
    border-color: var(--color-accent-tertiary);
    box-shadow:
      0 0 30px rgba(255, 107, 107, 0.15),
      0 10px 40px rgba(0, 0, 0, 0.3);
    transform: translateY(-4px) scale(1);
  }

  /* Card icon */
  .card-icon {
    width: 56px;
    height: 56px;
    margin: 0 auto 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, rgba(255, 107, 107, 0.15), rgba(255, 107, 107, 0.05));
    border-radius: 12px;
    color: var(--color-accent-tertiary);
    transition: transform 0.3s ease, background 0.3s ease;
  }

  .card-icon svg {
    width: 28px;
    height: 28px;
  }

  .problem-card:hover .card-icon {
    transform: scale(1.1);
    background: linear-gradient(135deg, rgba(255, 107, 107, 0.25), rgba(255, 107, 107, 0.1));
  }

  /* Card title */
  .card-title {
    color: var(--color-text-primary);
    transition: color 0.3s ease;
  }

  .problem-card:hover .card-title {
    color: var(--color-accent-tertiary);
  }

  /* Card accent decoration */
  .card-accent {
    position: absolute;
    top: 0;
    right: 0;
    width: 80px;
    height: 80px;
    background: linear-gradient(
      135deg,
      transparent 50%,
      rgba(255, 107, 107, 0.05) 50%
    );
    border-radius: 0 1rem 0 0;
    transition: opacity 0.3s ease;
    opacity: 0;
  }

  .problem-card:hover .card-accent {
    opacity: 1;
  }

  /* Solution hint */
  .solution-hint {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 3rem;
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.6s ease-out 0.5s, transform 0.6s ease-out 0.5s;
  }

  .solution-hint.visible {
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
    0%, 20%, 50%, 80%, 100% {
      transform: translateY(0);
    }
    40% {
      transform: translateY(6px);
    }
    60% {
      transform: translateY(3px);
    }
  }

  /* Responsive adjustments */
  @media (max-width: 768px) {
    .problem-card {
      padding: 1.5rem;
    }

    .card-icon {
      width: 48px;
      height: 48px;
    }

    .card-icon svg {
      width: 24px;
      height: 24px;
    }

    .gradient-blob-1 {
      width: 280px;
      height: 280px;
      opacity: 0.1;
    }

    .gradient-blob-2 {
      width: 220px;
      height: 220px;
      opacity: 0.1;
    }
  }

  /* Reduced motion support */
  @media (prefers-reduced-motion: reduce) {
    .section-title,
    .section-subtitle,
    .problem-card,
    .solution-hint {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .gradient-blob-1,
    .gradient-blob-2 {
      animation: none;
    }

    .hint-icon {
      animation: none;
    }

    .problem-card:hover {
      transform: none;
    }

    .problem-card:hover .card-icon {
      transform: none;
    }
  }
</style>
