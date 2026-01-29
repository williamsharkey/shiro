import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  base: '/shiro/',
  build: {
    target: 'es2022',
    rollupOptions: {
      external: [],
    },
  },
  resolve: {
    alias: [
      {
        find: /^\.\.\/fluffycoreutils\/(.*)/,
        replacement: path.resolve(__dirname, '../fluffycoreutils/$1'),
      },
      {
        find: /^\.\.\/spirit\/(.*)/,
        replacement: path.resolve(__dirname, '../spirit/$1'),
      },
      {
        find: /^\.\.\/\.\.\/spirit\/(.*)/,
        replacement: path.resolve(__dirname, '../spirit/$1'),
      },
    ],
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
  optimizeDeps: {
    include: ['isomorphic-git', 'http-cache-semantics'],
  },
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
