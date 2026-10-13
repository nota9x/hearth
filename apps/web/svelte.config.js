import { fileURLToPath } from 'node:url';

import adapter from '@sveltejs/adapter-cloudflare';
// hooks.server enforces the configured origin on every cookie-authenticated mutation.
// Native ShareX multipart requests have no Origin and use bearer authentication only.
export default {
  kit: {
    adapter: adapter({
      platformProxy: {
        persist: {
          path: fileURLToPath(new URL('.wrangler/state/v3', import.meta.url)),
        },
        remoteBindings: false,
      },
    }),
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
  },
};
