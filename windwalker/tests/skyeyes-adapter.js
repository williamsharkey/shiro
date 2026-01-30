#!/usr/bin/env node
// skyeyes-adapter.js -- Skyeyes-based page adapter for windwalker tests
// Provides a Puppeteer-compatible API using skyeyes HTTP interface

const SKYEYES_API = 'http://localhost:7777/api/skyeyes';

/**
 * Minimal Puppeteer-compatible Page object backed by skyeyes
 */
export class SkyeyesPage {
  constructor(pageName) {
    this.pageName = pageName;
    this._consoleHandlers = [];
    this._pageErrorHandlers = [];
    this._closed = false;
  }

  /**
   * Execute JavaScript code in the skyeyes page context
   */
  async evaluate(fn, ...args) {
    if (this._closed) throw new Error('Page is closed');

    // Convert function to string if it's a function
    let code;
    if (typeof fn === 'function') {
      const fnStr = fn.toString();
      // Extract function body
      const match = fnStr.match(/^(?:async\s+)?(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{?([\s\S]*?)\}?$/);
      if (match) {
        code = match[1].trim();
      } else {
        code = fnStr;
      }

      // If there are args, wrap in an IIFE with the args
      if (args.length > 0) {
        // Serialize args as JSON
        const argsJson = JSON.stringify(args);
        code = `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(', ')})`;
      }
    } else {
      code = fn;
    }

    const response = await fetch(`${SKYEYES_API}/${this.pageName}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      throw new Error(`Skyeyes request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    if (result.error) {
      throw new Error(result.error);
    }

    return result.result;
  }

  /**
   * Navigate to a URL (loads the page in skyeyes)
   */
  async goto(url, options = {}) {
    if (this._closed) throw new Error('Page is closed');

    // Navigate by setting window.location
    await this.evaluate(`window.location.href = "${url}"; "navigating..."`);

    // Wait for page to load
    const timeout = options.timeout || 30000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const ready = await this.evaluate('document.readyState');
        if (ready === 'complete' || ready === 'interactive') {
          // Additional wait if waitUntil is specified
          if (options.waitUntil === 'networkidle0' || options.waitUntil === 'networkidle2') {
            await new Promise(r => setTimeout(r, 500));
          }
          return { ok: true };
        }
      } catch (e) {
        // Page might not be ready yet
      }
      await new Promise(r => setTimeout(r, 100));
    }

    throw new Error(`Navigation timeout after ${timeout}ms`);
  }

  /**
   * Get page title
   */
  async title() {
    return this.evaluate('document.title');
  }

  /**
   * Wait for a function to return truthy
   */
  async waitForFunction(fn, options = {}) {
    const timeout = options.timeout || 30000;
    const polling = options.polling || 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const result = await this.evaluate(fn);
        if (result) return result;
      } catch (e) {
        // Continue polling
      }
      await new Promise(r => setTimeout(r, polling));
    }

    throw new Error(`waitForFunction timeout after ${timeout}ms`);
  }

  /**
   * Register console event handler
   */
  on(event, handler) {
    if (event === 'console') {
      this._consoleHandlers.push(handler);
    } else if (event === 'pageerror') {
      this._pageErrorHandlers.push(handler);
    }
  }

  /**
   * Close the page (in skyeyes, this is a no-op as pages persist)
   */
  async close() {
    this._closed = true;
  }

  /**
   * Check if page is closed
   */
  isClosed() {
    return this._closed;
  }
}

/**
 * Minimal Puppeteer-compatible Browser object for skyeyes
 */
export class SkyeyesBrowser {
  constructor() {
    this._pages = new Map();
  }

  /**
   * Create a new page (registers with skyeyes if not exists)
   */
  async newPage() {
    // Generate unique page name based on timestamp
    const pageName = `windwalker-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const page = new SkyeyesPage(pageName);
    this._pages.set(pageName, page);
    return page;
  }

  /**
   * Get or create a page with a specific name
   */
  async getPage(pageName) {
    if (this._pages.has(pageName)) {
      return this._pages.get(pageName);
    }
    const page = new SkyeyesPage(pageName);
    this._pages.set(pageName, page);
    return page;
  }

  /**
   * Close the browser (cleanup all pages)
   */
  async close() {
    for (const page of this._pages.values()) {
      await page.close();
    }
    this._pages.clear();
  }
}

/**
 * Launch a skyeyes-backed browser
 */
export async function launch(options = {}) {
  // Check if skyeyes is available
  try {
    const response = await fetch(`${SKYEYES_API}/health`).catch(() => null);
    if (!response || !response.ok) {
      console.warn('⚠ Skyeyes not available at', SKYEYES_API);
      console.warn('  Make sure skyeyes server is running on port 7777');
    }
  } catch (e) {
    console.warn('⚠ Could not connect to skyeyes:', e.message);
  }

  return new SkyeyesBrowser();
}

/**
 * For compatibility, export default as { launch }
 */
export default { launch, SkyeyesBrowser, SkyeyesPage };
