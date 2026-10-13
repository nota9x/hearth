import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
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
