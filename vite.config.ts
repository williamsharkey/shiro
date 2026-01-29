import { defineConfig } from 'vite';

export default defineConfig({
  base: '/shiro/',
  build: {
    target: 'es2022',
  },
  optimizeDeps: {
    include: ['isomorphic-git', 'http-cache-semantics'],
  },
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
