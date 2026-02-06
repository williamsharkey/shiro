import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const shiroRoot = path.resolve(__dirname, '../shiro');

export default defineConfig({
  plugins: [
    nodePolyfills({
      globals: {
        Buffer: true,
        process: true,
      },
    }),
  ],
  resolve: {
    alias: {
      // Clean alias for test imports
      '@shiro': path.resolve(shiroRoot, 'src'),
      '@shiro-fluffy': path.resolve(shiroRoot, 'fluffycoreutils/src'),
      '@shiro-adapter': path.resolve(shiroRoot, 'src'),
      // Aliases used internally by shiro source files when they import submodules
      '../fluffycoreutils': path.resolve(shiroRoot, 'fluffycoreutils'),
      '../spirit': path.resolve(shiroRoot, 'spirit'),
      '../../spirit': path.resolve(shiroRoot, 'spirit'),
    },
  },
  server: {
    fs: {
      allow: [shiroRoot, '..'],
    },
  },
  optimizeDeps: {
    include: ['isomorphic-git', 'http-cache-semantics'],
  },
  test: {
    setupFiles: ['./tests/shiro-vitest/setup.ts'],
    include: ['tests/shiro-vitest/**/*.test.ts'],
  },
});
