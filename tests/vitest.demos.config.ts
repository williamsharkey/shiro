import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const shiroRoot = path.resolve(__dirname, '..');

/**
 * Separate vitest config for GitHub Player demos tests.
 * Run: cd tests && npx vitest run --config vitest.demos.config.ts
 */
export default defineConfig({
  plugins: [
    nodePolyfills({
      globals: { Buffer: true, process: true },
      exclude: ['fs', 'child_process', 'module'],
    }),
  ],
  resolve: {
    alias: {
      '@shiro': path.resolve(shiroRoot, 'src'),
      '@xterm/xterm/css/xterm.css': path.resolve(__dirname, 'tests/shiro-vitest/stubs/xterm.css.ts'),
    },
  },
  server: {
    fs: { allow: [shiroRoot, '..'] },
  },
  optimizeDeps: {
    include: ['isomorphic-git', 'http-cache-semantics'],
  },
  test: {
    setupFiles: ['./tests/shiro-vitest/setup.ts'],
    include: ['tests/shiro-vitest/github-player-*.test.ts'],
  },
});
