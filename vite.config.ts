import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
  },
  optimizeDeps: {
    include: ['isomorphic-git', 'http-cache-semantics'],
  },
});
