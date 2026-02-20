/**
 * Vite plugin: inline the entry JS/CSS and favicon into index.html at build time.
 * Dynamic import chunks (lazy-loaded commands) stay as separate .js files in dist/
 * for code splitting. The entry chunk is the one referenced by <script src> in HTML.
 */
import type { Plugin } from 'vite';
import { readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';

export function inlineAssets(): Plugin {
  let outDir = '';

  return {
    name: 'vite-plugin-inline-assets',
    enforce: 'post',
    apply: 'build',

    configResolved(config) {
      outDir = config.build.outDir;
    },

    generateBundle(_options, bundle) {
      const htmlKey = Object.keys(bundle).find(k => k.endsWith('.html') && !k.includes('/'));
      if (!htmlKey) return;

      const htmlAsset = bundle[htmlKey];
      if (htmlAsset.type !== 'asset') return;

      let html = typeof htmlAsset.source === 'string'
        ? htmlAsset.source
        : new TextDecoder().decode(htmlAsset.source);

      // Inline only the entry JS chunk (referenced by <script src> in HTML).
      // Dynamic import chunks are NOT referenced in HTML — they stay as files.
      html = html.replace(
        /<script\b[^>]*\bsrc=["']\.?\/?([^"']+\.js)["'][^>]*><\/script>/g,
        (_match, src) => {
          const chunk = bundle[src];
          if (chunk && chunk.type === 'chunk' && chunk.isEntry) {
            // Resolve Vite's module preload dep markers. Vite's internal
            // buildImportAnalysisPlugin replaces __VITE_PRELOAD__ with actual
            // dep arrays after all plugins' generateBundle hooks — but we're
            // inlining the code now, before that pass runs. Our lazy chunks
            // have no CSS/shared deps, so `void 0` (no deps) is correct.
            let code = chunk.code;
            if (code.includes('__VITE_PRELOAD__')) {
              code = code.replace(/__VITE_PRELOAD__/g, 'void 0');
            }
            // The entry chunk was in assets/ alongside lazy chunks, so its
            // dynamic imports use "./chunk.js". Now that it's inlined into
            // index.html (one level up), rewrite to "./assets/chunk.js".
            const assetDir = src.split('/')[0]; // e.g. "assets"
            if (assetDir) {
              code = code.replace(
                /import\("\.\/([^"]+\.js)"\)/g,
                (_m, file) => `import("./${assetDir}/${file}")`,
              );
            }
            // Keep the entry chunk file — lazy chunks import shared code
            // from it (e.g. import {...} from "./index-xxx.js"). We inline
            // it into HTML for fast boot, but it must also stay as a file.
            return `<script type="module">${code}</script>`;
          }
          return _match;
        }
      );

      // Inline CSS: <link rel="stylesheet" crossorigin href="./assets/xxx.css">
      html = html.replace(
        /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']\.?\/?([^"']+\.css)["'][^>]*\/?>/g,
        (_match, href) => {
          const asset = bundle[href];
          if (asset && asset.type === 'asset') {
            const css = typeof asset.source === 'string'
              ? asset.source
              : new TextDecoder().decode(asset.source);
            delete bundle[href]; // remove standalone CSS file
            return `<style>${css}</style>`;
          }
          return _match;
        }
      );

      // Inline favicon: <link rel="icon" ... href="./favicon.svg" />
      html = html.replace(
        /<link\b[^>]*\brel=["']icon["'][^>]*\bhref=["']\.?\/?([^"']+\.svg)["'][^>]*\/?>/g,
        (_match, href) => {
          const asset = bundle[href];
          if (asset && asset.type === 'asset') {
            const svg = typeof asset.source === 'string'
              ? asset.source
              : new TextDecoder().decode(asset.source);
            const b64 = Buffer.from(svg).toString('base64');
            delete bundle[href];
            return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${b64}" />`;
          }
          try {
            const svg = readFileSync(resolve('public', href), 'utf-8');
            const b64 = Buffer.from(svg).toString('base64');
            if (bundle[href]) delete bundle[href];
            return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${b64}" />`;
          } catch {
            return _match;
          }
        }
      );

      htmlAsset.source = html;
    },

    writeBundle() {
      // Clean up public files that were inlined (favicon.svg)
      try { unlinkSync(resolve(outDir, 'favicon.svg')); } catch {}
    },
  };
}
