// The Browser app's scoreboard (docs/WEB_SCORE.md): popular sites scored
// loads / renders / interactive, plus video, a WebSocket app, login pages,
// a Speedometer 3 subset and a handful of Web Platform Tests, in two columns:
//
//   direct  the host browser loading the site in a real tab (the ceiling)
//   tab     tabcomputer's Browser app: browse origins + broker + TLS in the page
//   tab-server  the same, with the server-side fetch (local comparison only:
//           the server must run with TABCOMPUTER_BROWSE_SERVER_FETCH=1; never in production)
//
//   npm run build
//   TABCOMPUTER_TCP_RELAY=1 TABCOMPUTER_TCP_ORIGINS=http://localhost:5299 PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/web-score.mjs [--app http://localhost:5299] [--modes direct,tab]
//        [--only id,id] [--skip-sites] [--speedometer] [--wpt] [--json out.json] [--md docs/WEB_SCORE.md]
//        [--extra-roots /root/.ccr/ca-bundle.crt]
//
// --extra-roots adds PEM roots to the Browser app's trust store (a sandbox
// whose egress re-signs TLS needs its CA there, exactly like a company proxy).
// Needs playwright-core (NODE_PATH=/opt/node-tools/node_modules) and Chromium.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
for (const m of ['playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright-core', '/opt/node-tools/node_modules/playwright']) {
  try { ({ chromium } = require(m)); break; } catch { /* next */ }
}

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (n) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true; };
const APP = opt('--app', 'http://localhost:5299').replace(/\/$/, '');
const MODES = opt('--modes', 'direct,tab').split(',');
const ONLY = opt('--only', '');
const JSON_OUT = opt('--json', '');
const MD_OUT = opt('--md', '');
const ROOTS = opt('--extra-roots', existsSync('/root/.ccr/ca-bundle.crt') ? '/root/.ccr/ca-bundle.crt' : '');
const SPEEDO = flag('--speedometer');
const WPT = flag('--wpt');
const SKIP_SITES = flag('--skip-sites');
const FROM_JSON = opt('--from-json', '');
const LOAD_MS = Number(opt('--load-timeout', '45000'));
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';

// kind: search (fill + Enter must navigate or change the page), link (a click
// must navigate), login (the sign-in form must appear). Selectors are hints;
// heuristics fill in.
export const SITES = [
  { id: 'google', url: 'https://www.google.com/', kind: 'search', sel: 'textarea[name=q],input[name=q]' },
  { id: 'youtube', url: 'https://www.youtube.com/', kind: 'search', sel: 'input[name=search_query]' },
  { id: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Main_Page', kind: 'search', sel: 'input[name=search]' },
  { id: 'amazon', url: 'https://www.amazon.com/', kind: 'search', sel: '#twotabsearchtextbox' },
  { id: 'reddit', url: 'https://www.reddit.com/', kind: 'link' },
  { id: 'github', url: 'https://github.com/', kind: 'link' },
  { id: 'stackoverflow', url: 'https://stackoverflow.com/questions', kind: 'link' },
  { id: 'bing', url: 'https://www.bing.com/', kind: 'search', sel: '#sb_form_q' },
  { id: 'duckduckgo', url: 'https://duckduckgo.com/', kind: 'search', sel: 'input[name=q]' },
  { id: 'yahoo', url: 'https://www.yahoo.com/', kind: 'search', sel: 'input[name=p]' },
  { id: 'bbc', url: 'https://www.bbc.com/', kind: 'link' },
  { id: 'cnn', url: 'https://www.cnn.com/', kind: 'link' },
  { id: 'nytimes', url: 'https://www.nytimes.com/', kind: 'link' },
  { id: 'theguardian', url: 'https://www.theguardian.com/international', kind: 'link' },
  { id: 'x', url: 'https://x.com/', kind: 'link' },
  { id: 'facebook', url: 'https://www.facebook.com/', kind: 'login' },
  { id: 'instagram', url: 'https://www.instagram.com/accounts/login/', kind: 'login' },
  { id: 'linkedin', url: 'https://www.linkedin.com/login', kind: 'login' },
  { id: 'netflix', url: 'https://www.netflix.com/login', kind: 'login' },
  { id: 'microsoft', url: 'https://www.microsoft.com/en-us/', kind: 'link' },
  { id: 'apple', url: 'https://www.apple.com/', kind: 'link' },
  { id: 'ebay', url: 'https://www.ebay.com/', kind: 'search', sel: '#gh-ac,input[name=_nkw]' },
  { id: 'craigslist', url: 'https://sfbay.craigslist.org/', kind: 'link' },
  { id: 'imdb', url: 'https://www.imdb.com/', kind: 'search', sel: '#suggestion-search,input[name=q]' },
  { id: 'twitch', url: 'https://www.twitch.tv/', kind: 'link' },
  { id: 'espn', url: 'https://www.espn.com/', kind: 'link' },
  { id: 'weather', url: 'https://weather.com/', kind: 'link' },
  { id: 'paypal', url: 'https://www.paypal.com/signin', kind: 'login' },
  { id: 'hackernews', url: 'https://news.ycombinator.com/', kind: 'link' },
  { id: 'mdn', url: 'https://developer.mozilla.org/en-US/', kind: 'link' },
  { id: 'npm', url: 'https://www.npmjs.com/', kind: 'search', sel: 'input[name=q]' },
  { id: 'archive', url: 'https://archive.org/', kind: 'link' },
  { id: 'openstreetmap', url: 'https://www.openstreetmap.org/', kind: 'search', sel: '#query,input[name=query]' },
  { id: 'booking', url: 'https://www.booking.com/', kind: 'link' },
  { id: 'airbnb', url: 'https://www.airbnb.com/', kind: 'link' },
  { id: 'spotify', url: 'https://open.spotify.com/', kind: 'link' },
  { id: 'zoom', url: 'https://zoom.us/', kind: 'link' },
  { id: 'dropbox', url: 'https://www.dropbox.com/login', kind: 'login' },
  { id: 'medium', url: 'https://medium.com/', kind: 'link' },
  { id: 'pinterest', url: 'https://www.pinterest.com/', kind: 'link' },
  { id: 'tiktok', url: 'https://www.tiktok.com/', kind: 'link' },
  { id: 'walmart', url: 'https://www.walmart.com/', kind: 'search', sel: 'input[name=q]' },
  { id: 'cloudflare', url: 'https://www.cloudflare.com/', kind: 'link' },
  { id: 'w3schools', url: 'https://www.w3schools.com/', kind: 'link' },
  { id: 'nasa', url: 'https://www.nasa.gov/', kind: 'link' },
  { id: 'govuk', url: 'https://www.gov.uk/', kind: 'search', sel: 'input[name=q],#search-main' },
  { id: 'etsy', url: 'https://www.etsy.com/', kind: 'search', sel: 'input[name=search_query]' },
  { id: 'live-login', url: 'https://login.live.com/', kind: 'login' },
  { id: 'discord-login', url: 'https://discord.com/login', kind: 'login' },
  { id: 'google-signin', url: 'https://accounts.google.com/', kind: 'login', expectFallback: 'google-signin' },
  // Special cases
  { id: 'video', url: 'https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_4K.webm', kind: 'video' },
  { id: 'websocket', url: 'https://echo.websocket.org/.ws', kind: 'ws', minText: 50 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, step = 250) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* frame navigating */ }
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

// ── mode drivers ─────────────────────────────────────────────────────────────
// Each gives: open(url) → {ok, ms, error}; frame() → the site's current Frame;
// url() → its real URL; stats() → {bytes, requests}; close().

async function directDriver(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: false });
  if (WPT) await ctx.addInitScript(WPT_HOOK);
  let page = await ctx.newPage();
  let bytes = 0, requests = 0;
  const watch = (p) => p.on('requestfinished', async (r) => { requests++; try { const s = await r.sizes(); bytes += s.responseBodySize + s.responseHeadersSize; } catch { /* gone */ } });
  watch(page);
  return {
    name: 'direct', get page() { return page; },
    async open(url) {
      // A fresh page per site: a late navigation from the last one must not land here
      const old = page;
      page = await ctx.newPage();
      watch(page);
      await old.close().catch(() => {});
      bytes = 0; requests = 0;
      const t0 = Date.now();
      try {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
        return { ok: true, ms: Date.now() - t0, status: res?.status() ?? 0 };
      } catch (e) { return { ok: false, ms: Date.now() - t0, error: String(e.message).split('\n')[0] }; }
    },
    frame: async () => page.mainFrame(),
    url: async () => page.url(),
    stats: async () => ({ bytes, requests }),
    async memory() {
      const s = await ctx.newCDPSession(page);
      const h = await s.send('Runtime.getHeapUsage');
      await s.detach();
      return h.usedSize;
    },
    fallback: async () => null,
    close: () => ctx.close(),
  };
}

async function tabDriver(browser, transport = 'relay') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (WPT) await ctx.addInitScript(WPT_HOOK);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { if (process.env.WEB_SCORE_DEBUG) console.log('[app pageerror]', e.message); });
  await page.goto(`${APP}/?ui=desktop`);
  await page.waitForFunction(() => window.__tabcomputer?.desktop, null, { timeout: 90000 });
  if (ROOTS) {
    const pem = readFileSync(ROOTS, 'utf8');
    await page.evaluate(async (pem) => {
      const r = indexedDB.open('tabcomputer-browser', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      const db = await new Promise((res) => { r.onsuccess = () => res(r.result); });
      await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(pem, 'extraRoots'); t.oncomplete = res; });
      db.close();
    }, pem);
  }
  await page.evaluate(async (transport) => {
    const r = indexedDB.open('tabcomputer-browser', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    const db = await new Promise((res) => { r.onsuccess = () => res(r.result); });
    await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(transport, 'transport'); t.oncomplete = res; });
    db.close();
  }, transport);
  await page.evaluate(() => window.__tabcomputer.desktop.openApp('browser', {}));
  await page.waitForFunction(() => window.__shiroBrowser?.engine, null, { timeout: 30000 });
  const got = await page.evaluate(() => window.__shiroBrowser.engine.transport);
  if (got !== transport) throw new Error(`transport ${transport} unavailable (server needs TABCOMPUTER_BROWSE_SERVER_FETCH=1)`);
  await page.evaluate(() => { const w = window.__tabcomputer.desktop.focused(); w?.maximize(); });
  const active = () => page.evaluate(() => { const t = window.__shiroBrowser.window.active; return t && { url: t.url, bytes: t.bytes, requests: t.requests, fallback: t.fallback, title: t.title }; });
  const frame = async () => {
    const el = await page.$('.sd-br-view iframe.sd-active');
    return el ? el.contentFrame() : null;
  };
  return {
    name: transport === 'server' ? 'tab-server' : 'tab', page,
    async open(url) {
      const t0 = Date.now();
      await page.evaluate(() => { const w = window.__shiroBrowser.window; for (const t of w.tabs.slice(0, -1)) w.closeTab(t); });
      await page.evaluate((url) => { const w = window.__shiroBrowser.window; const old = w.active; w.newTab(url); if (old) w.closeTab(old); }, url);
      // Loaded = a document with the page runtime (not the navigation shell) past readyState loading
      const ok = await until(async () => {
        const fb = (await active())?.fallback;
        if (fb) return { fallback: fb };
        const f = await frame();
        if (!f) return null;
        return f.evaluate(() => window.__tcClient === true && document.readyState !== 'loading' && !!document.body);
      }, LOAD_MS);
      if (ok?.fallback) return { ok: false, ms: Date.now() - t0, error: `fallback: ${ok.fallback.reason}`, fallback: ok.fallback.reason };
      return ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, ms: Date.now() - t0, error: 'timeout' };
    },
    frame,
    url: async () => (await active())?.url ?? '',
    stats: async () => { const a = await active(); return { bytes: a?.bytes ?? 0, requests: a?.requests ?? 0 }; },
    async memory() {
      const f = await frame();
      if (!f) return 0;
      const s = await ctx.newCDPSession(f).catch(() => null);
      if (!s) return 0;
      const h = await s.send('Runtime.getHeapUsage');
      await s.detach();
      return h.usedSize;
    },
    fallback: async () => (await active())?.fallback?.reason ?? null,
    close: () => ctx.close(),
  };
}

// ── checks ───────────────────────────────────────────────────────────────────

async function renders(d, site = {}) {
  const f = await d.frame();
  if (!f) return { ok: false, why: 'no frame' };
  const r = await f.evaluate(() => {
    // Text in open shadow roots counts too (Reddit, archive.org are web components)
    const deepText = (root) => {
      let n = 0;
      const walk = (node) => {
        if (node.shadowRoot) walk(node.shadowRoot);
        for (const c of node.childNodes) {
          if (c.nodeType === 3) n += c.textContent.trim().length;
          else if (c.nodeType === 1 && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(c.tagName)) walk(c);
        }
      };
      walk(root);
      return n;
    };
    const text = Math.max((document.body?.innerText || '').trim().length, document.body ? deepText(document.body) : 0);
    const imgs = Array.from(document.images).filter((i) => i.complete && i.naturalWidth > 0).length;
    const svgs = document.querySelectorAll('svg').length;
    const canvases = document.querySelectorAll('canvas').length;
    const sheets = document.styleSheets.length;
    const h = document.documentElement.scrollHeight;
    // Styled = the body's font or the first heading isn't the UA default
    const styled = sheets > 0 || !!document.querySelector('[style]');
    return { text, imgs, svgs, canvases, sheets, h, styled };
  }).catch((e) => ({ error: String(e.message) }));
  if (r.error) return { ok: false, why: r.error };
  const ok = r.styled && (r.text >= (site.minText ?? 200) || r.imgs + r.canvases + r.svgs >= 3) && r.h >= 200;
  return { ok, why: ok ? '' : JSON.stringify(r), detail: r };
}

async function interactive(d, site) {
  const before = await d.url();
  const f = await d.frame();
  if (!f) return { ok: false, why: 'no frame' };
  if (site.kind === 'login') {
    const r = await until(() => f.evaluate(() => {
      const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const pw = Array.from(document.querySelectorAll('input[type=password]')).some(vis);
      const user = Array.from(document.querySelectorAll('input[type=email],input[autocomplete~=username],input[name*=user i],input[name*=login i],input[name*=email i],input[id*=email i],input[name=loginfmt]')).some(vis);
      return pw || user ? (pw ? 'password' : 'username') : null;
    }), 15000);
    return { ok: !!r, why: r ? r : 'no sign-in form' };
  }
  if (site.kind === 'video') {
    const r = await f.evaluate(async () => {
      const vs = Array.from(document.querySelectorAll('video'));
      if (!vs.length) return 'no video';
      for (const v of vs) {
        v.muted = true; v.preload = 'auto';
        if (v.readyState === 0) v.load();
        v.play().catch(() => {});
      }
      for (let i = 0; i < 120; i++) {
        if (vs.some((v) => v.currentTime > 1)) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return vs.map((v) => `${v.currentSrc.slice(-40) || 'no src'}: t=${v.currentTime.toFixed(1)} rs=${v.readyState} err=${v.error?.code ?? '-'}`).join('; ');
    }).catch((e) => String(e.message));
    return { ok: r === true, why: r === true ? '' : r };
  }
  if (site.kind === 'ws') {
    const r = await f.evaluate(() => new Promise((resolve) => {
      let ws;
      try { ws = new WebSocket('wss://echo.websocket.org/'); } catch (e) { resolve('ctor: ' + e.message); return; }
      const t = setTimeout(() => resolve('timeout'), 15000);
      ws.onmessage = (e) => { if (String(e.data).includes('tc-ping')) { clearTimeout(t); ws.close(); resolve(true); } };
      ws.onopen = () => ws.send('tc-ping');
      ws.onerror = () => { clearTimeout(t); resolve('error event'); };
    })).catch((e) => String(e.message));
    return { ok: r === true, why: r === true ? '' : r };
  }
  if (site.kind === 'search') {
    const generic = 'input[type=search],input[name=q],textarea[name=q],input[name=p],input[aria-label*=earch i],input[placeholder*=earch i]';
    const sel = site.sel ? `${site.sel},${generic}` : generic;
    const handle = await f.waitForSelector(sel, { state: 'attached', timeout: 15000 }).catch(() => null);
    if (!handle) return { ok: false, why: `no ${sel}` };
    const changedText = await f.evaluate(() => document.body.innerText.length).catch(() => 0);
    await handle.evaluate((el) => { el.focus(); }).catch(() => {});
    await handle.fill('web browser').catch(async () => { await handle.evaluate((el) => { el.value = 'web browser'; el.dispatchEvent(new Event('input', { bubbles: true })); }); });
    await handle.press('Enter').catch(async () => { await handle.evaluate((el) => el.form?.requestSubmit?.()); });
    const r = await until(async () => {
      const now = await d.url();
      if (now && now !== before) return 'navigated';
      return null;
    }, 15000);
    if (r) return { ok: true, why: r };
    const f2 = await d.frame();
    const len = await f2?.evaluate(() => document.body.innerText.length).catch(() => 0);
    return { ok: false, why: `no navigation (text ${changedText}→${len})` };
  }
  // link: click the first visible same-site link to another page
  const target = await f.evaluate(() => {
    const here = location.href.split('#')[0];
    const host = location.hostname;
    const as = [];
    const collect = (root) => {
      for (const a of root.querySelectorAll('a[href]')) as.push(a);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot);
    };
    collect(document);
    for (const a of as) {
      const href = a.href;
      if (!/^https?:/.test(href) || href.split('#')[0] === here || a.target === '_blank') continue;
      let u; try { u = new URL(href); } catch { continue; }
      if (u.hostname !== host || u.pathname === '/' || u.pathname === location.pathname) continue;
      const b = a.getBoundingClientRect();
      if (b.width < 4 || b.height < 4 || b.top < 0 || b.top > innerHeight * 3) continue;
      if (/login|signin|sign-in|logout|account|cart|javascript/i.test(href)) continue;
      a.setAttribute('data-tc-score', '1');
      return href;
    }
    return null;
  }).catch(() => null);
  if (!target) return { ok: false, why: 'no link' };
  await f.evaluate(() => {
    const find = (root) => root.querySelector('[data-tc-score]') ?? Array.from(root.querySelectorAll('*')).map((e) => e.shadowRoot && find(e.shadowRoot)).find(Boolean);
    find(document)?.click();
  }).catch(() => {});
  const r = await until(async () => { const now = await d.url(); return now && now !== before ? now : null; }, 15000);
  return { ok: !!r, why: r ? '' : `click ${target} did not navigate` };
}

async function scoreSite(d, site) {
  const row = { id: site.id, url: site.url, kind: site.kind };
  const load = await d.open(site.url);
  row.loads = load.ok;
  row.loadMs = load.ms;
  if (!load.ok) {
    row.error = load.error;
    if (load.fallback) row.fallback = load.fallback;
    return row;
  }
  await sleep(3000); // let it settle
  const r = await renders(d, site);
  row.renders = r.ok;
  if (!r.ok) row.renderWhy = r.why;
  const st = await d.stats();
  row.bytes = st.bytes;
  row.requests = st.requests;
  row.memory = await d.memory().catch(() => 0);
  const i = await interactive(d, site).catch((e) => ({ ok: false, why: String(e.message).split('\n')[0] }));
  row.interactive = i.ok;
  if (!i.ok) row.interactiveWhy = i.why;
  const fb = await d.fallback();
  if (fb) row.fallback = fb;
  return row;
}

// ── Speedometer 3 subset ─────────────────────────────────────────────────────
const SPEEDO_URL = 'https://browserbench.org/Speedometer3.1/?suites=TodoMVC-JavaScript-ES5,TodoMVC-Preact-Complex-DOM,NewsSite-Next&iterationCount=3&startAutomatically';

async function speedometer(d) {
  const load = await d.open(SPEEDO_URL);
  if (!load.ok) return { ok: false, error: load.error };
  const t0 = Date.now();
  const score = await until(async () => {
    const f = await d.frame();
    return f?.evaluate(() => {
      const el = document.querySelector('#result-number');
      const t = el?.textContent?.trim();
      return t && /\d/.test(t) ? t : null;
    });
  }, 300000, 1000);
  return score ? { ok: true, score: Number(score), ms: Date.now() - t0 } : { ok: false, error: 'no score in 5 min' };
}

// ── Web Platform Tests (wpt.live) for the interception layer ─────────────────
export const WPT_TESTS = [
  '/fetch/api/basic/request-headers.any.html',
  '/fetch/api/basic/accept-header.any.html',
  '/fetch/api/basic/response-url.sub.any.html',
  '/fetch/api/redirect/redirect-count.any.html',
  '/fetch/api/redirect/redirect-mode.any.html',
  '/fetch/api/cors/cors-basic.any.html',
  '/fetch/api/cors/cors-preflight.any.html',
  '/fetch/api/credentials/cookies.any.html',
  '/fetch/content-encoding/gzip/gzip-body.any.html',
  '/fetch/range/general.any.html',
  '/xhr/send-redirect.htm',
  '/cookies/attributes/path.html',
  '/cookies/samesite/fetch.https.html',
  '/html/browsers/history/the-location-interface/location_hostname.html',
];

async function wpt(d, path) {
  const load = await d.open('https://wpt.live' + path);
  if (!load.ok) return { path, ok: false, error: load.error };
  // testharness.js keeps its results in window.tests; read them, not the rendered summary
  const res = await until(async () => {
    const f = await d.frame();
    return f?.evaluate(() => {
      if (window.__wptResult) return window.__wptResult;
      // Fallback: the rendered results table (status cells carry pass/fail classes)
      if (!document.querySelector('#summary')) return null;
      const cells = Array.from(document.querySelectorAll('#results tbody tr td:first-child'));
      const n = (c) => cells.filter((x) => x.className.includes(c)).length;
      return { total: cells.length, pass: n('pass'), fail: n('fail'), timeout: n('timeout'), notrun: n('notrun') };
    });
  }, 90000, 1000);
  return res ? { path, ok: true, ...res } : { path, ok: false, error: 'harness did not complete in 90 s' };
}

/** testharness.js keeps results private: catch add_completion_callback as it is exposed. */
const WPT_HOOK = `(() => {
  let v;
  try {
    Object.defineProperty(self, 'add_completion_callback', { configurable: true, get() { return v; }, set(fn) {
      v = fn;
      try { fn((tests) => { const n = (s) => tests.filter((t) => t.status === s).length;
        self.__wptResult = { total: tests.length, pass: n(0), fail: n(1), timeout: n(2), notrun: n(3) }; }); } catch {}
    } });
  } catch {}
})();`;

// ── main ─────────────────────────────────────────────────────────────────────
if (FROM_JSON) { writeMarkdown(MD_OUT || 'docs/WEB_SCORE.md', JSON.parse(readFileSync(FROM_JSON, 'utf8'))); process.exit(0); }
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const results = { date: new Date().toISOString(), app: APP, chromium: browser.version(), modes: {} };
const sites = SITES.filter((s) => !ONLY || ONLY.split(',').includes(s.id));
for (const mode of MODES) {
  const make = mode === 'direct' ? directDriver : mode === 'tab-server' ? (b) => tabDriver(b, 'server') : tabDriver;
  let d = await make(browser);
  const out = results.modes[mode] = { sites: [], speedometer: null, wpt: [] };
  if (!SKIP_SITES) {
    for (const site of sites) {
      let row;
      try {
        row = await Promise.race([scoreSite(d, site), sleep(150000).then(() => { throw new Error('site timed out (150 s)'); })]);
      } catch (e) {
        row = { id: site.id, url: site.url, loads: false, error: String(e.message).split('\n')[0] };
        try { await d.close(); } catch { /* gone */ }
        d = await make(browser);
      }
      out.sites.push(row);
      const mark = (v) => (v ? '✓' : v === false ? '✗' : '–');
      console.log(`${mode.padEnd(6)} ${site.id.padEnd(16)} load ${mark(row.loads)} render ${mark(row.renders)} interact ${mark(row.interactive)}`
        + ` ${row.loadMs ?? '-'}ms ${row.bytes ? (row.bytes / 1048576).toFixed(1) + 'MB' : ''} ${row.memory ? (row.memory / 1048576).toFixed(0) + 'MB heap' : ''}`
        + `${row.fallback ? ' fallback=' + row.fallback : ''}${row.error ? ' ' + row.error : ''}${row.renderWhy ? ' render: ' + row.renderWhy.slice(0, 120) : ''}${row.interactiveWhy ? ' interact: ' + row.interactiveWhy.slice(0, 120) : ''}`);
      if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
    }
  }
  if (SPEEDO) {
    out.speedometer = await speedometer(d).catch((e) => ({ ok: false, error: String(e.message) }));
    console.log(`${mode} speedometer`, JSON.stringify(out.speedometer));
  }
  if (WPT) {
    for (const p of WPT_TESTS) {
      const r = await wpt(d, p).catch((e) => ({ path: p, ok: false, error: String(e.message) }));
      out.wpt.push(r);
      console.log(`${mode} wpt ${p} ${r.ok ? `${r.pass}/${r.total}` : r.error}`);
    }
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
  await d.close();
}
await browser.close();

// ── summary ──────────────────────────────────────────────────────────────────
for (const [mode, r] of Object.entries(results.modes)) {
  const s = r.sites;
  if (!s.length) continue;
  const n = (k) => s.filter((x) => x[k]).length;
  console.log(`${mode}: loads ${n('loads')}/${s.length}, renders ${n('renders')}/${s.length}, interactive ${n('interactive')}/${s.length}`);
}
if (MD_OUT) writeMarkdown(MD_OUT, results);

/** Replace the generated part of docs/WEB_SCORE.md (between the web-score markers). */
function writeMarkdown(file, res) {
  const modes = Object.keys(res.modes);
  const mark = (v) => (v ? '✓' : v === false ? '✗' : '–');
  const med = (xs) => { const a = xs.filter((x) => x > 0).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const mb = (b) => (b ? (b / 1048576).toFixed(1) : '–');
  const lines = [];
  lines.push(`Run ${res.date.slice(0, 16).replace('T', ' ')} UTC, Chromium ${res.chromium}, app ${res.app}.`, '');
  lines.push(`| | ${modes.join(' | ')} |`, `|---|${modes.map(() => '---:').join('|')}|`);
  const sites = (m) => res.modes[m].sites;
  const count = (m, k) => `${sites(m).filter((x) => x[k]).length}/${sites(m).length}`;
  lines.push(`| loads | ${modes.map((m) => count(m, 'loads')).join(' | ')} |`);
  lines.push(`| renders | ${modes.map((m) => count(m, 'renders')).join(' | ')} |`);
  lines.push(`| interactive | ${modes.map((m) => count(m, 'interactive')).join(' | ')} |`);
  lines.push(`| median time to load | ${modes.map((m) => `${med(sites(m).map((x) => x.loadMs && x.loads ? x.loadMs : 0))} ms`).join(' | ')} |`);
  lines.push(`| median download per page | ${modes.map((m) => `${mb(med(sites(m).map((x) => x.bytes || 0)))} MB`).join(' | ')} |`);
  lines.push(`| median JS heap per tab | ${modes.map((m) => `${mb(med(sites(m).map((x) => x.memory || 0)))} MB`).join(' | ')} |`);
  lines.push('');
  const ids = [...new Set(modes.flatMap((m) => sites(m).map((x) => x.id)))];
  lines.push(`| site | kind | ${modes.map((m) => `${m} L R I`).join(' | ')} | ${modes.map((m) => `${m} load`).join(' | ')} | ${modes.map((m) => `${m} MB`).join(' | ')} | notes |`);
  lines.push(`|---|---|${modes.map(() => ':---:').join('|')}|${modes.map(() => '---:').join('|')}|${modes.map(() => '---:').join('|')}|---|`);
  for (const id of ids) {
    const rows = modes.map((m) => sites(m).find((x) => x.id === id) || {});
    const any = rows.find((r) => r.url) || {};
    const last = rows[rows.length - 1];
    const note = [last.fallback ? `fallback: ${last.fallback}` : '', last.error || '', last.renderWhy ? 'render: ' + last.renderWhy : '', last.interactiveWhy ? 'interactive: ' + last.interactiveWhy : '']
      .filter(Boolean).join('; ').replace(/\|/g, '/').slice(0, 140);
    lines.push(`| [${id}](${any.url}) | ${any.kind ?? ''} | ${rows.map((r) => `${mark(r.loads)} ${mark(r.renders)} ${mark(r.interactive)}`).join(' | ')} | ${rows.map((r) => (r.loadMs && r.loads ? `${(r.loadMs / 1000).toFixed(1)} s` : '–')).join(' | ')} | ${rows.map((r) => mb(r.bytes)).join(' | ')} | ${note} |`);
  }
  if (modes.some((m) => res.modes[m].speedometer)) {
    lines.push('', '**Speedometer 3.1 subset** (TodoMVC-JavaScript-ES5, TodoMVC-Preact-Complex-DOM, NewsSite-Next; 3 iterations):', '');
    lines.push(`| | ${modes.join(' | ')} |`, `|---|${modes.map(() => '---:').join('|')}|`);
    lines.push(`| score | ${modes.map((m) => { const sp = res.modes[m].speedometer; return sp?.ok ? String(sp.score) : (sp?.error ?? '–'); }).join(' | ')} |`);
  }
  if (modes.some((m) => res.modes[m].wpt?.length)) {
    lines.push('', '**Web Platform Tests** (wpt.live; passed/total subtests):', '');
    lines.push(`| test | ${modes.join(' | ')} |`, `|---|${modes.map(() => '---:').join('|')}|`);
    const paths = [...new Set(modes.flatMap((m) => res.modes[m].wpt.map((w) => w.path)))];
    for (const p of paths) {
      lines.push(`| [${p}](https://wpt.live${p}) | ${modes.map((m) => { const w = res.modes[m].wpt.find((x) => x.path === p); return w?.ok ? `${w.pass}/${w.total}` : (w?.error ?? '–'); }).join(' | ')} |`);
    }
  }
  const gen = lines.join('\n');
  let doc = existsSync(file) ? readFileSync(file, 'utf8') : '<!-- web-score:begin -->\n<!-- web-score:end -->\n';
  const b = '<!-- web-score:begin -->', e = '<!-- web-score:end -->';
  if (!doc.includes(b)) doc += `\n${b}\n${e}\n`;
  doc = doc.slice(0, doc.indexOf(b) + b.length) + '\n' + gen + '\n' + doc.slice(doc.indexOf(e));
  writeFileSync(file, doc);
  console.log(`wrote ${file}`);
}
