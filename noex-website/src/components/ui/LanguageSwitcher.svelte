<script lang="ts">
  import { locales, localeNames, getLocalizedPath, type Locale } from '../../i18n/utils';

  /** Current active locale */
  export let currentLocale: Locale;
  /** Current page path for generating localized URLs */
  export let currentPath: string;
  /** Translations for accessibility */
  export let translations: {
    label: string;
    currentLang: string;
  } = {
    label: 'Language',
    currentLang: 'Current language'
  };
</script>

<nav
  class="language-switcher"
  role="navigation"
  aria-label={translations.label}
>
  {#each locales as locale}
    {@const isActive = locale === currentLocale}
    {@const href = getLocalizedPath(currentPath, locale)}
    <a
      {href}
      class="lang-link"
      class:active={isActive}
      aria-current={isActive ? 'page' : undefined}
      aria-label={isActive
        ? `${localeNames[locale]} (${translations.currentLang})`
        : localeNames[locale]}
      hreflang={locale}
    >
      {locale.toUpperCase()}
    </a>
  {/each}
</nav>

<style>
  .language-switcher {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .lang-link {
    padding: 0.375rem 0.625rem;
    font-size: 0.875rem;
    font-weight: 500;
    border-radius: 0.375rem;
    text-decoration: none;
    transition: all 0.15s ease;
    color: var(--color-text-secondary);
  }

  .lang-link:hover:not(.active) {
    color: var(--color-text-primary);
    background: var(--color-bg-card);
  }

  .lang-link:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: 2px;
  }

  .lang-link.active {
    color: var(--color-accent-primary);
    background: rgba(0, 255, 136, 0.1);
  }
</style>
