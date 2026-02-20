import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// tests/ is inside shiro monorepo, shiroRoot is the parent directory.
const shiroRoot = path.resolve(__dirname, '..');

export default defineConfig({
  plugins: [
    nodePolyfills({
      globals: {
        Buffer: true,
        process: true,
      },
      // Don't polyfill fs/child_process — tests need real Node.js access
      // (build-output.test.ts reads dist/ files). Shiro source code doesn't
      // import these modules; only isomorphic-git needs Buffer/process.
      exclude: ['fs', 'child_process', 'module'],
    }),
  ],
  resolve: {
    alias: {
      // Clean alias for test imports
      '@shiro': path.resolve(shiroRoot, 'src'),
      // CSS import is a no-op in Node.js tests
      '@xterm/xterm/css/xterm.css': path.resolve(__dirname, 'tests/shiro-vitest/stubs/xterm.css.ts'),
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
