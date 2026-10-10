/**
 * The node-worker guest (src/node-worker/guest.ts) bundled with esbuild and
 * run in Node worker_threads, as the browser runs it in a Worker.
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import type { GuestWorker } from '@shiro/kernel/worker-host';
import { drainNodeWorkerPool, setNodeWorkerFactory } from '@shiro/node-worker/host';

const REPO = path.resolve(__dirname, '../../..');
/** The guest's __BUILD_SHA__ (the build's commit in the browser; claude-transform-cache.ts keys on it) */
export const TEST_BUILD_SHA = 'node-worker-test';

/** Build the guest and make it node's worker; returns the cleanup */
export async function installNodeWorker(): Promise<() => void> {
  const tmp = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'shiro-node-worker-'));
  const entry = path.join(tmp, 'entry.ts');
  writeFileSync(entry, `
    import { parentPort } from 'node:worker_threads';
    import { nodeGuestMain } from ${JSON.stringify(path.join(REPO, 'src/node-worker/guest.ts'))};
    nodeGuestMain((h) => { parentPort!.on('message', h); }, (m) => parentPort!.postMessage(m));
  `);
  const file = path.join(tmp, 'node-guest.mjs');
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error',
    // (a CommonJS dependency's require() of a node builtin, in an ES module bundle)
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    define: { __BUILD_SHA__: JSON.stringify(TEST_BUILD_SHA) },
    // vite's `X?url` (an asset's URL: build.ts's esbuild.wasm): the file's path
    plugins: [{
      name: 'url-import',
      setup(b) {
        b.onResolve({ filter: /\?url$/ }, (a) => ({ path: createRequire(path.join(a.resolveDir, 'x.js')).resolve(a.path.slice(0, -4)), namespace: 'url-import' }));
        b.onLoad({ filter: /.*/, namespace: 'url-import' }, (a) => ({ contents: `export default ${JSON.stringify(a.path)};`, loader: 'js' }));
      },
    }],
  });
  setNodeWorkerFactory((): GuestWorker => {
    const w = new Worker(file);
    return {
      postMessage: (m) => w.postMessage(m),
      terminate: () => w.terminate(),
      onMessage: (cb) => { w.on('message', cb); },
      onError: (cb) => { w.on('error', cb); },
      onExit: (cb) => { w.on('exit', cb); },
    };
  });
  return () => { drainNodeWorkerPool(); setNodeWorkerFactory(null); rmSync(tmp, { recursive: true, force: true }); };
}
