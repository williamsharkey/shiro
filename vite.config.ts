import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { inlineAssets } from './vite-plugin-inline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use './' for relative paths (works with file:// and hosted)
const base = process.env.VITE_BASE_PATH || './';

export default defineConfig({
  base,
  plugins: [
    nodePolyfills({
      // Enable Buffer polyfill for isomorphic-git
      globals: {
        Buffer: true,
        process: true,
      },
    }),
    inlineAssets(),
  ],
  build: {
    target: 'es2022',
    rollupOptions: {
      external: [],
    },
  },
  resolve: {
    alias: [
      {
        // Handle imports like ../fluffycoreutils/src/index from src/ files
        find: /^\.\.\/fluffycoreutils\/(.*)/,
        replacement: path.resolve(__dirname, 'fluffycoreutils/$1'),
      },
      {
        // Handle imports like ../spirit/src/... from src/ files
        find: /^\.\.\/spirit\/(.*)/,
        replacement: path.resolve(__dirname, 'spirit/$1'),
      },
      {
        // Handle imports like ../../spirit/src/... from deeper directories
        find: /^\.\.\/\.\.\/spirit\/(.*)/,
        replacement: path.resolve(__dirname, 'spirit/$1'),
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
