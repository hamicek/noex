import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [
    svelte({
      configFile: resolve(import.meta.dirname, 'svelte.config.js'),
    }),
  ],

  root: resolve(import.meta.dirname, 'src/client'),

  build: {
    outDir: resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },

  resolve: {
    alias: {
      $lib: resolve(import.meta.dirname, 'src/client/lib'),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },

  preview: {
    port: 4173,
  },
});
