/**
 * Build output validation tests.
 *
 * These verify the Vite build produces valid output — catching issues like
 * unresolved build markers that only manifest at runtime in the browser.
 * Run after `npx vite build` to validate dist/.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';

// Resolve dist/ — vitest runs from tests/ or shiro/
const shiroRoot = process.cwd().endsWith('/tests')
  ? process.cwd().slice(0, -6) // strip '/tests'
  : process.cwd();
const distDir = shiroRoot + '/dist';
const indexPath = distDir + '/index.html';

const hasDist = existsSync(indexPath);

describe.skipIf(!hasDist)('Build Output Validation', () => {
  function readFile(path: string): string {
    return readFileSync(path, 'utf-8');
  }

  function listJsFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter(f => f.endsWith('.js'));
    } catch { return []; }
  }

  let html: string;

  it('dist/index.html should exist and be non-trivial', () => {
    html = readFile(indexPath);
    expect(html.length).toBeGreaterThan(1000);
  });

  it('should not contain unresolved __VITE_PRELOAD__ markers', () => {
    html = html || readFile(indexPath);
    const matches = html.match(/__VITE_PRELOAD__/g);
    expect(matches).toBeNull();
  });

  it('should contain the inlined entry script', () => {
    html = html || readFile(indexPath);
    expect(html).toContain('<script type="module">');
    // Exclude absolute URLs (CDN scripts in template data are OK)
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=["'](?!https?:\/\/)[^"']*\.js["']/);
  });

  it('should contain the inlined CSS', () => {
    html = html || readFile(indexPath);
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["'](?!https?:\/\/)[^"']*\.css["']/);
  });

  it('entry chunk should exist in dist/assets/ (lazy chunks import from it)', () => {
    const jsFiles = listJsFiles(distDir + '/assets');
    const entryFile = jsFiles.find(f => f.startsWith('index-'));
    expect(entryFile).toBeTruthy();
  });

  it('lazy chunks should exist in dist/assets/', () => {
    const jsFiles = listJsFiles(distDir + '/assets');
    // Exclude entry chunk from count
    const lazyFiles = jsFiles.filter(f => !f.startsWith('index-'));
    expect(lazyFiles.length).toBeGreaterThanOrEqual(10);
  });

  it('lazy chunks should not contain unresolved markers', () => {
    const jsFiles = listJsFiles(distDir + '/assets');
    for (const file of jsFiles) {
      const content = readFile(distDir + '/assets/' + file);
      expect(content).not.toContain('__VITE_PRELOAD__');
    }
  });

  it('dynamic imports should reference assets/ directory', () => {
    html = html || readFile(indexPath);
    // After inlining, dynamic imports must point to ./assets/ not ./
    // (entry chunk moved from assets/ to index.html root)
    const imports = html.match(/import\("[^"]*\.js"\)/g) || [];
    expect(imports.length).toBeGreaterThanOrEqual(10);
    for (const imp of imports) {
      expect(imp).toMatch(/import\("\.\/assets\//);
    }
  });

  it('should not have other unresolved Vite markers', () => {
    html = html || readFile(indexPath);
    expect(html).not.toContain('__VITE_IS_MODERN__');
    expect(html).not.toContain('__VITE_PUBLIC_ASSET__');
  });
});
