// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://noexjs.org',

  integrations: [
    svelte(),
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: 'en-US',
          cs: 'cs-CZ',
        },
      },
    }),
  ],

  server: {
    port: 7240,
  },

  vite: {
    plugins: [tailwindcss()],
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'cs'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
});