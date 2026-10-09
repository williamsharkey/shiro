import { createHash } from 'crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

/**
 * Content-hashed copies of the engines' wasm (dist/engines/<engine>/<name>.<sha>.wasm)
 * and dist/engines/manifest.json naming them, so a page loads each wasm from a URL
 * that can be cached for good (server.mjs: immutable) and a new build's wasm is a
 * new URL. The plain names stay for older pages and the `doctor` command.
 */
export function hashEngineWasm(): Plugin {
  let outDir = 'dist';
  return {
    name: 'hash-engine-wasm',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const engines = path.join(outDir, 'engines');
      if (!existsSync(engines)) return;
      const manifest: Record<string, string> = {};
      for (const engine of readdirSync(engines, { withFileTypes: true })) {
        if (!engine.isDirectory()) continue;
        for (const name of readdirSync(path.join(engines, engine.name))) {
          if (!name.endsWith('.wasm') || /\.[0-9a-f]{12}\.wasm$/.test(name)) continue;
          const file = path.join(engines, engine.name, name);
          const sha = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
          const hashed = name.replace(/\.wasm$/, `.${sha}.wasm`);
          copyFileSync(file, path.join(engines, engine.name, hashed));
          manifest[`${engine.name}/${name}`] = `${engine.name}/${hashed}`;
        }
      }
      writeFileSync(path.join(engines, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    },
  };
}
