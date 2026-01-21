<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  /** CSS selector for sections to track */
  export let sectionSelector = '.snap-section';
  /** CSS selector for the scroll container */
  export let containerSelector = '.snap-container';
  /** ARIA label for accessibility */
  export let ariaLabel = 'Page sections';

  let sections: Element[] = [];
  let container: Element | null = null;
  let activeIndex = 0;
  let observer: IntersectionObserver | null = null;

  function scrollToSection(index: number) {
    const section = sections[index];
    if (section) {
      section.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    // Skip if user is typing in an input or textarea
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    const sectionCount = sections.length;
    if (sectionCount === 0) return;

    switch (event.key) {
      case 'ArrowDown':
      case 'PageDown':
        event.preventDefault();
        scrollToSection(Math.min(activeIndex + 1, sectionCount - 1));
        break;

      case 'ArrowUp':
      case 'PageUp':
        event.preventDefault();
        scrollToSection(Math.max(activeIndex - 1, 0));
        break;

      case 'Home':
        event.preventDefault();
        scrollToSection(0);
        break;

      case 'End':
        event.preventDefault();
        scrollToSection(sectionCount - 1);
        break;

      case ' ': // Space
        // Only handle space if not focused on interactive elements
        if (target.tagName !== 'BUTTON' && target.tagName !== 'A') {
          event.preventDefault();
          // Space scrolls down, Shift+Space scrolls up
          if (event.shiftKey) {
            scrollToSection(Math.max(activeIndex - 1, 0));
          } else {
            scrollToSection(Math.min(activeIndex + 1, sectionCount - 1));
          }
        }
        break;
    }
  }

  function setupObserver() {
    if (!container || sections.length === 0) return;

    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const index = sections.indexOf(entry.target);
            if (index !== -1) {
              activeIndex = index;
            }
          }
        });
      },
      {
        root: container,
        threshold: 0.5,
      }
    );

    sections.forEach((section) => observer?.observe(section));
  }

  onMount(() => {
    container = document.querySelector(containerSelector);
    sections = Array.from(document.querySelectorAll(sectionSelector));

    setupObserver();
    document.addEventListener('keydown', handleKeyDown);
  });

  onDestroy(() => {
    observer?.disconnect();
    document.removeEventListener('keydown', handleKeyDown);
  });
</script>

<nav
  class="scroll-indicator"
  role="navigation"
  aria-label={ariaLabel}
>
  {#each sections as _, index}
    <button
      class="dot"
      class:active={index === activeIndex}
      on:click={() => scrollToSection(index)}
      aria-label="Go to section {index + 1}"
      aria-current={index === activeIndex ? 'true' : undefined}
      tabindex={-1}
    >
      <span class="sr-only">Section {index + 1}</span>
    </button>
  {/each}
</nav>

<style>
  .scroll-indicator {
    position: fixed;
    right: 2rem;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    z-index: 40;
  }

  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--color-border);
    border: none;
    padding: 0;
    cursor: pointer;
    transition: all 0.3s ease;
  }

  .dot:hover {
    background: var(--color-text-secondary);
    transform: scale(1.2);
  }

  .dot:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
  }

  .dot.active {
    background: var(--color-accent-primary);
    box-shadow: 0 0 12px var(--color-accent-primary);
  }

  /* Screen reader only text */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Hide on mobile - touch scroll is natural */
  @media (max-width: 768px) {
    .scroll-indicator {
      display: none;
    }
  }
</style>
