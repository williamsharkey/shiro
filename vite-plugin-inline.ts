/**
 * Vite plugin: inline all JS/CSS assets into index.html at build time.
 * Produces a single self-contained HTML file with no external references.
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

      // Inline JS: <script type="module" crossorigin src="./assets/xxx.js"></script>
      html = html.replace(
        /<script\b[^>]*\bsrc=["']\.?\/?([^"']+\.js)["'][^>]*><\/script>/g,
        (_match, src) => {
          const chunk = bundle[src];
          if (chunk && chunk.type === 'chunk') {
            delete bundle[src]; // remove standalone JS file
            return `<script type="module">${chunk.code}</script>`;
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
      // Favicon comes from public/ dir so it's not in the bundle — read from disk or bundle
      html = html.replace(
        /<link\b[^>]*\brel=["']icon["'][^>]*\bhref=["']\.?\/?([^"']+\.svg)["'][^>]*\/?>/g,
        (_match, href) => {
          // Check bundle first
          const asset = bundle[href];
          if (asset && asset.type === 'asset') {
            const svg = typeof asset.source === 'string'
              ? asset.source
              : new TextDecoder().decode(asset.source);
            const b64 = Buffer.from(svg).toString('base64');
            delete bundle[href];
            return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${b64}" />`;
          }
          // Try reading from public dir (Vite copies public files directly)
          try {
            const svg = readFileSync(resolve('public', href), 'utf-8');
            const b64 = Buffer.from(svg).toString('base64');
            // Mark for deletion after write
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
