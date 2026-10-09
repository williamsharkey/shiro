import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { inlineAssets } from './vite-plugin-inline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use './' for relative paths (works with file:// and hosted)
const base = process.env.VITE_BASE_PATH || './';

// Same cross-origin isolation headers as server.mjs, so SharedArrayBuffer works
// under `npm run dev` / `vite preview` too. SHIRO_ISOLATION=0 turns them off.
const isolationHeaders: Record<string, string> = process.env.SHIRO_ISOLATION === '0' ? {} : {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

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
      output: {
        // three.js (the Liquid glass icon set, src/desktop/iconset-glass.ts) is its own chunk
        manualChunks: (id) => (id.includes('/node_modules/three/') ? 'three' : undefined),
      },
    },
  },
  // module workers (src/gui/deb-worker.ts) that import code-split chunks
  worker: { format: 'es' },
  resolve: {},
  server: {
    headers: isolationHeaders,
    fs: {
      allow: ['..'],
    },
  },
  preview: {
    headers: isolationHeaders,
  },
  optimizeDeps: {
    include: ['isomorphic-git', 'http-cache-semantics'],
  },
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
