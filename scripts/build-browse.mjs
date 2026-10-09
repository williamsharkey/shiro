// Bundles the Browser app's browse-origin scripts (docs/BROWSER.md) into
// dist/browse/: sw.js (the per-origin service worker), boot.js (first visit and
// navigation shell), client.js (the page runtime) and shim.js (the runtime's
// script shims, for workers). They are served by
// server.mjs on browse origins only, at /__tc/*.js. Run by `npm run build`
// after vite; `node scripts/build-browse.mjs [outdir]` alone works too.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.resolve(process.argv[2] || path.join(root, 'dist', 'browse'));
await build({
  entryPoints: { sw: 'src/browser/sw.ts', boot: 'src/browser/boot.ts', client: 'src/browser/client.ts', shim: 'src/browser/shim-entry.ts' },
  absWorkingDir: root,
  outdir,
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`browse scripts → ${path.relative(root, outdir)}/{sw,boot,client,shim}.js`);
