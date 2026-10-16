import { fileURLToPath } from 'node:url';

import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({
        platformProxy: {
          ...(process.env.HEARTH_LOCAL_CONFIG && {
            configPath: process.env.HEARTH_LOCAL_CONFIG,
          }),
          persist: {
            path: fileURLToPath(new URL('.wrangler/state/v3', import.meta.url)),
          },
          remoteBindings: false,
        },
      }),
      // hooks.server enforces exact APP_ORIGIN for cookies; ShareX uses bearer auth without Origin.
      csrf: { trustedOrigins: ['*'] },
      csp: {
        mode: 'auto',
        directives: {
          'default-src': ['self'],
          'script-src': ['self', 'https://challenges.cloudflare.com'],
          'frame-src': ['https://challenges.cloudflare.com'],
          'style-src': ['self', 'unsafe-inline'],
          'img-src': ['self', 'blob:', 'data:'],
          'connect-src': ['self', 'https://challenges.cloudflare.com'],
          'object-src': ['none'],
          'base-uri': ['self'],
          'frame-ancestors': ['none'],
        },
      },
    }),
  ],
  ssr: {
    noExternal: ['zod'],
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    watch: { ignored: ['**/.wrangler/**', '**/artifacts/**'] },
  },
  clearScreen: false,
});
