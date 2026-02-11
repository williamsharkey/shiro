import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { pageCmd } from '@shiro/commands/page';
import { parseHTML } from 'linkedom';

/**
 * The page command finds iframes by [data-virtual-port] attribute
 * and accesses their contentDocument directly (same-origin srcdoc).
 *
 * In linkedom, we simulate this by creating DOM iframes and polyfilling
 * contentDocument with a linkedom-parsed document.
 */

function createMockIframe(port: number, html: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('data-virtual-port', String(port));
  document.body.appendChild(iframe);

  // linkedom doesn't support iframe.contentDocument natively.
  // Use linkedom's parseHTML to create a real document.
  const { document: doc } = parseHTML(html);
  Object.defineProperty(iframe, 'contentDocument', {
    value: doc, writable: true, configurable: true,
  });
  Object.defineProperty(iframe, 'contentWindow', {
    value: {
      eval: (code: string) => {
        const fn = new Function('document', 'return ' + code);
        return fn(doc);
      },
    },
    writable: true,
    configurable: true,
  });
  return iframe;
}

describe('page command — served app interaction', () => {
  let shell: Shell;
  let fs: FileSystem;
  const iframes: HTMLIFrameElement[] = [];

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    shell.commands.register(pageCmd);
  });

  afterEach(() => {
    // Clean up any test iframes
    for (const iframe of iframes) iframe.remove();
    iframes.length = 0;
    // Also clean any stray iframes
    document.querySelectorAll('[data-virtual-port]').forEach(el => el.remove());
    const bc = document.getElementById('become-container');
    if (bc) bc.remove();
  });

  function addIframe(port: number, html: string) {
    const iframe = createMockIframe(port, html);
    iframes.push(iframe);
    return iframe;
  }

  describe('no server windows open', () => {
    it('should error when no iframes exist', async () => {
      const r = await run(shell, 'page click #btn');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('no server windows open');
    });

    it('should show usage with no arguments', async () => {
      const r = await run(shell, 'page');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('Usage:');
    });
  });

  describe('single iframe — auto-detect', () => {
    it('should read text content from body', async () => {
      addIframe(3000, '<html><body><p>Hello World</p></body></html>');
      const r = await run(shell, 'page text');
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('Hello World');
    });

    it('should read text from a selector', async () => {
      addIframe(3000, '<html><body><h1 id="title">Greetings</h1><p>Other text</p></body></html>');
      const r = await run(shell, 'page text #title');
      expect(r.exitCode).toBe(0);
      expect(r.output.trim()).toBe('Greetings');
    });

    it('should get innerHTML', async () => {
      addIframe(3000, '<html><body><div id="wrap"><em>bold</em></div></body></html>');
      const r = await run(shell, 'page html #wrap');
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('<em>bold</em>');
    });

    it('should get document title', async () => {
      addIframe(3000, '<html><head><title>My App</title></head><body></body></html>');
      const r = await run(shell, 'page title');
      expect(r.exitCode).toBe(0);
      expect(r.output.trim()).toBe('My App');
    });

    it('should click an element (exit code 0)', async () => {
      addIframe(3000, '<html><body><button id="btn">Go</button></body></html>');
      // Attach a click listener on the parsed doc
      const iframe = document.querySelector('[data-virtual-port="3000"]') as HTMLIFrameElement;
      let clicked = false;
      iframe.contentDocument?.getElementById('btn')?.addEventListener('click', () => { clicked = true; });
      const r = await run(shell, 'page click #btn');
      expect(r.exitCode).toBe(0);
      expect(clicked).toBe(true);
    });

    it('should set input value', async () => {
      addIframe(3000, '<html><body><input id="name" value="" /></body></html>');
      const iframe = document.querySelector('[data-virtual-port="3000"]') as HTMLIFrameElement;
      const input = iframe.contentDocument?.getElementById('name') as HTMLInputElement;
      // Quote the selector so # isn't treated as a shell comment
      const r = await run(shell, 'page input "#name" William');
      expect(r.exitCode).toBe(0);
      expect(input.value).toBe('William');
    });

    it('should get an attribute', async () => {
      addIframe(3000, '<html><body><a id="link" href="/about">About</a></body></html>');
      const r = await run(shell, 'page attr #link href');
      expect(r.exitCode).toBe(0);
      expect(r.output.trim()).toBe('/about');
    });

    it('should error on missing attribute', async () => {
      addIframe(3000, '<html><body><div id="d">Hi</div></body></html>');
      const r = await run(shell, 'page attr #d data-foo');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('no attribute');
    });

    it('should error on element not found', async () => {
      addIframe(3000, '<html><body></body></html>');
      const r = await run(shell, 'page click #nonexistent');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('element not found');
    });

    it('should error on unknown action', async () => {
      addIframe(3000, '<html><body></body></html>');
      const r = await run(shell, 'page dance #el');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('Unknown action');
    });
  });

  describe('port targeting', () => {
    it('should target a specific port with :port syntax', async () => {
      addIframe(3000, '<html><body><p id="a">App A</p></body></html>');
      addIframe(4000, '<html><body><p id="a">App B</p></body></html>');
      const r = await run(shell, 'page :4000 text #a');
      expect(r.exitCode).toBe(0);
      expect(r.output.trim()).toBe('App B');
    });

    it('should error when multiple windows and no port given', async () => {
      addIframe(3000, '<html><body></body></html>');
      addIframe(4000, '<html><body></body></html>');
      const r = await run(shell, 'page text');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('multiple server windows');
    });

    it('should error when targeted port has no window', async () => {
      addIframe(3000, '<html><body></body></html>');
      const r = await run(shell, 'page :9999 text');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('no open window for port 9999');
    });
  });

  describe('eval', () => {
    it('should eval JS in the iframe context', async () => {
      addIframe(3000, '<html><body><div id="n">0</div></body></html>');
      const iframe = document.querySelector('[data-virtual-port="3000"]') as HTMLIFrameElement;
      // Ensure contentWindow.eval works
      const doc = iframe.contentDocument;
      if (doc && iframe.contentWindow) {
        const r = await run(shell, 'page eval document.title');
        // Should return something (possibly empty title)
        expect(r.exitCode).toBe(0);
      }
    });

    it('should error on empty eval', async () => {
      const r = await run(shell, 'page eval');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('Usage:');
    });
  });

  describe('become-mode iframe', () => {
    it('should find the become-mode iframe', async () => {
      // Simulate become mode: create #become-container with an iframe
      const container = document.createElement('div');
      container.id = 'become-container';
      const iframe = document.createElement('iframe');
      container.appendChild(iframe);
      document.body.appendChild(container);

      // Polyfill contentDocument for linkedom
      const { document: doc } = parseHTML(
        '<html><head><title>Become App</title></head><body><h1>Full Screen</h1></body></html>',
      );
      Object.defineProperty(iframe, 'contentDocument', {
        value: doc, writable: true, configurable: true,
      });

      const r = await run(shell, 'page title');
      expect(r.exitCode).toBe(0);
      expect(r.output.trim()).toBe('Become App');

      container.remove();
    });
  });

  describe('wait', () => {
    it('should find an existing element immediately', async () => {
      addIframe(3000, '<html><body><div id="ready">done</div></body></html>');
      const r = await run(shell, 'page wait #ready 500');
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('found');
    });

    it('should timeout when element does not exist', async () => {
      addIframe(3000, '<html><body></body></html>');
      const r = await run(shell, 'page wait #missing 200');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('timeout');
    });

    it('should error with no selector', async () => {
      const r = await run(shell, 'page wait');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('Usage:');
    });
  });
});
