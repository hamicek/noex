<script lang="ts">
  import { onMount } from 'svelte';
  import LanguageSwitcher from './LanguageSwitcher.svelte';
  import type { Locale } from '../../i18n/utils';

  interface NavTranslations {
    features: string;
    playground: string;
    github: string;
    hero: string;
    problem: string;
    services: string;
    observability: string;
    distribution: string;
    cta: string;
    openMenu: string;
    closeMenu: string;
  }

  interface Props {
    locale: Locale;
    currentPath: string;
    translations: NavTranslations;
    langSwitcherTranslations: {
      label: string;
      currentLang: string;
    };
    githubUrl?: string;
  }

  let {
    locale,
    currentPath,
    translations,
    langSwitcherTranslations,
    githubUrl = 'https://github.com/hamicek/noex',
  }: Props = $props();

  let isMenuOpen = $state(false);
  let isScrolled = $state(false);
  let navRef: HTMLElement | null = $state(null);

  // Navigation sections with their IDs and translation keys
  const sections = [
    { id: 'hero', key: 'hero' as const },
    { id: 'why-noex', key: 'problem' as const },
    { id: 'features', key: 'features' as const },
    { id: 'services', key: 'services' as const },
    { id: 'observability', key: 'observability' as const },
    { id: 'distribution', key: 'distribution' as const },
    { id: 'playground', key: 'playground' as const },
    { id: 'cta', key: 'cta' as const },
  ];

  function toggleMenu() {
    isMenuOpen = !isMenuOpen;
    // Prevent body scroll when menu is open
    if (typeof document !== 'undefined') {
      document.body.style.overflow = isMenuOpen ? 'hidden' : '';
    }
  }

  function closeMenu() {
    isMenuOpen = false;
    if (typeof document !== 'undefined') {
      document.body.style.overflow = '';
    }
  }

  function scrollToSection(sectionId: string) {
    const section = document.getElementById(sectionId);
    const container = document.querySelector('.snap-container') as HTMLElement | null;
    if (section && container) {
      // Temporarily disable scroll-snap to avoid snap-stop blocking
      container.style.scrollSnapType = 'none';

      container.scrollTo({
        top: section.offsetTop - 64, // 4rem nav offset
        behavior: 'smooth',
      });

      // Re-enable snap after scroll completes
      const onScrollEnd = () => {
        container.style.scrollSnapType = '';
        container.removeEventListener('scrollend', onScrollEnd);
        clearTimeout(fallback);
      };
      container.addEventListener('scrollend', onScrollEnd, { once: true });
      const fallback = setTimeout(() => {
        container.style.scrollSnapType = '';
        container.removeEventListener('scrollend', onScrollEnd);
      }, 1000);

      closeMenu();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && isMenuOpen) {
      closeMenu();
    }
  }

  onMount(() => {
    const scrollContainer = document.querySelector('.snap-container');

    // Track scroll position for nav background opacity
    const handleScroll = () => {
      if (scrollContainer) {
        isScrolled = scrollContainer.scrollTop > 50;
      }
    };

    scrollContainer?.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('keydown', handleKeydown);

    return () => {
      scrollContainer?.removeEventListener('scroll', handleScroll);
      window.removeEventListener('keydown', handleKeydown);
      // Cleanup body overflow on unmount
      if (typeof document !== 'undefined') {
        document.body.style.overflow = '';
      }
    };
  });
</script>

<nav
  bind:this={navRef}
  class="nav-container"
  class:scrolled={isScrolled}
  role="navigation"
  aria-label="Main navigation"
>
  <div class="nav-inner">
    <!-- Logo -->
    <a
      href={`/${locale}/`}
      class="logo"
      onclick={() => scrollToSection('hero')}
    >
      <span class="logo-text">noex</span>
    </a>

    <!-- Desktop Navigation -->
    <div class="desktop-nav" role="menubar">
      {#each sections.slice(0, 4) as section}
        <button
          class="nav-link"
          role="menuitem"
          onclick={() => scrollToSection(section.id)}
        >
          {translations[section.key]}
        </button>
      {/each}
      <a
        href={githubUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="nav-link"
        role="menuitem"
      >
        {translations.github}
        <svg class="external-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </a>
    </div>

    <!-- Language Switcher (Desktop) -->
    <div class="desktop-lang">
      <LanguageSwitcher
        currentLocale={locale}
        {currentPath}
        translations={langSwitcherTranslations}
      />
    </div>

    <!-- Mobile Menu Button -->
    <button
      class="mobile-menu-button"
      onclick={toggleMenu}
      aria-expanded={isMenuOpen}
      aria-controls="mobile-menu"
      aria-label={isMenuOpen ? translations.closeMenu : translations.openMenu}
    >
      <span class="hamburger" class:open={isMenuOpen}>
        <span class="hamburger-line"></span>
        <span class="hamburger-line"></span>
        <span class="hamburger-line"></span>
      </span>
    </button>
  </div>

  <!-- Mobile Menu Overlay -->
  {#if isMenuOpen}
    <div
      class="mobile-overlay"
      onclick={closeMenu}
      onkeydown={(e) => e.key === 'Enter' && closeMenu()}
      role="button"
      tabindex="-1"
      aria-label="Close menu"
    ></div>
  {/if}

  <!-- Mobile Menu -->
  <div
    id="mobile-menu"
    class="mobile-menu"
    class:open={isMenuOpen}
    role="menu"
    aria-hidden={!isMenuOpen}
  >
    <div class="mobile-menu-content">
      <!-- Section Links -->
      <div class="mobile-sections">
        {#each sections as section}
          <button
            class="mobile-nav-link"
            role="menuitem"
            tabindex={isMenuOpen ? 0 : -1}
            onclick={() => scrollToSection(section.id)}
          >
            {translations[section.key]}
          </button>
        {/each}
      </div>

      <!-- Divider -->
      <div class="mobile-divider"></div>

      <!-- External Links -->
      <div class="mobile-external">
        <a
          href={githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="mobile-nav-link external"
          role="menuitem"
          tabindex={isMenuOpen ? 0 : -1}
        >
          {translations.github}
          <svg class="external-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
      </div>

      <!-- Language Switcher (Mobile) -->
      <div class="mobile-lang">
        <LanguageSwitcher
          currentLocale={locale}
          {currentPath}
          translations={langSwitcherTranslations}
        />
      </div>
    </div>
  </div>
</nav>

<style>
  .nav-container {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 50;
    background: rgba(10, 10, 15, 0.7);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid transparent;
    transition: all 0.3s ease;
  }

  .nav-container.scrolled {
    background: rgba(10, 10, 15, 0.9);
    border-bottom-color: var(--color-border);
  }

  .nav-inner {
    max-width: 80rem;
    margin: 0 auto;
    padding: 0 1rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 4rem;
  }

  @media (min-width: 640px) {
    .nav-inner {
      padding: 0 1.5rem;
    }
  }

  @media (min-width: 1024px) {
    .nav-inner {
      padding: 0 2rem;
    }
  }

  /* Logo */
  .logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    z-index: 60;
  }

  .logo-text {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--color-accent-primary);
    transition: text-shadow 0.3s ease;
  }

  .logo:hover .logo-text {
    text-shadow: 0 0 20px rgba(0, 255, 136, 0.5);
  }

  .logo:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 4px;
    border-radius: 4px;
  }

  /* Desktop Navigation */
  .desktop-nav {
    display: none;
    align-items: center;
    gap: 0.25rem;
  }

  @media (min-width: 768px) {
    .desktop-nav {
      display: flex;
    }
  }

  .nav-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.875rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    text-decoration: none;
    transition: all 0.15s ease;
  }

  .nav-link:hover {
    color: var(--color-text-primary);
    background: rgba(255, 255, 255, 0.05);
  }

  .nav-link:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
  }

  .external-icon {
    opacity: 0.7;
    transition: opacity 0.15s ease;
  }

  .nav-link:hover .external-icon {
    opacity: 1;
  }

  /* Desktop Language Switcher */
  .desktop-lang {
    display: none;
  }

  @media (min-width: 768px) {
    .desktop-lang {
      display: block;
      margin-left: 1rem;
    }
  }

  /* Mobile Menu Button */
  .mobile-menu-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 0.5rem;
    cursor: pointer;
    z-index: 60;
    transition: background 0.15s ease;
  }

  .mobile-menu-button:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .mobile-menu-button:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
  }

  @media (min-width: 768px) {
    .mobile-menu-button {
      display: none;
    }
  }

  /* Hamburger Icon */
  .hamburger {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    width: 20px;
    height: 20px;
  }

  .hamburger-line {
    display: block;
    width: 100%;
    height: 2px;
    background: var(--color-text-primary);
    border-radius: 1px;
    transition: all 0.3s ease;
    transform-origin: center;
  }

  .hamburger.open .hamburger-line:nth-child(1) {
    transform: translateY(7px) rotate(45deg);
  }

  .hamburger.open .hamburger-line:nth-child(2) {
    opacity: 0;
    transform: scaleX(0);
  }

  .hamburger.open .hamburger-line:nth-child(3) {
    transform: translateY(-7px) rotate(-45deg);
  }

  /* Mobile Overlay */
  .mobile-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 40;
    animation: fadeIn 0.2s ease;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  /* Mobile Menu */
  .mobile-menu {
    position: fixed;
    top: 0;
    right: 0;
    width: 100%;
    max-width: 320px;
    height: 100dvh;
    background: var(--color-bg-secondary);
    border-left: 1px solid var(--color-border);
    z-index: 45;
    transform: translateX(100%);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .mobile-menu.open {
    transform: translateX(0);
  }

  @media (min-width: 768px) {
    .mobile-menu {
      display: none;
    }
  }

  .mobile-menu-content {
    display: flex;
    flex-direction: column;
    padding: 5rem 1.5rem 2rem;
    min-height: 100%;
  }

  .mobile-sections {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .mobile-nav-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.875rem 1rem;
    font-size: 1rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-radius: 0.5rem;
    cursor: pointer;
    text-decoration: none;
    text-align: left;
    transition: all 0.15s ease;
  }

  .mobile-nav-link:hover,
  .mobile-nav-link:focus {
    color: var(--color-text-primary);
    background: rgba(255, 255, 255, 0.05);
  }

  .mobile-nav-link:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: -2px;
  }

  .mobile-nav-link.external {
    color: var(--color-accent-primary);
  }

  .mobile-divider {
    height: 1px;
    background: var(--color-border);
    margin: 1rem 0;
  }

  .mobile-external {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .mobile-lang {
    margin-top: auto;
    padding-top: 1.5rem;
    border-top: 1px solid var(--color-border);
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .nav-container,
    .logo-text,
    .nav-link,
    .hamburger-line,
    .mobile-overlay,
    .mobile-menu,
    .mobile-nav-link {
      transition: none;
    }

    .mobile-overlay {
      animation: none;
    }
  }
</style>
