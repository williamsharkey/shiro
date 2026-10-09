import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { inlineAssets } from './vite-plugin-inline';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use './' for relative paths (works with file:// and hosted)
const base = process.env.VITE_BASE_PATH || './';

// Same cross-origin isolation headers as server.mjs, so SharedArrayBuffer works
// under `npm run dev` / `vite preview` too. TABCOMPUTER_ISOLATION=0 turns them off.
const isolationHeaders: Record<string, string> = process.env.TABCOMPUTER_ISOLATION === '0' ? {} : {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

// The commit this build came from, so `doctor` can tell a tab opened before a
// deploy from the current one ('' outside a git checkout)
let buildSha = '';
try { buildSha = execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no git */ }

export default defineConfig({
  base,
  define: { __BUILD_SHA__: JSON.stringify(buildSha) },
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
    // its worker is new URL('./worker.js', import.meta.url): pre-bundling would lose the file
    exclude: ['@ffmpeg/ffmpeg'],
  },
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
