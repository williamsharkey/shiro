/**
 * The Browser app's `location` rewrite (docs/BROWSER.md, "location"):
 * jsrewrite.ts on scripts, shim.ts's globals in a separate realm, HTML inline
 * scripts and handlers, and the broker's script path with integrity checks.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { rewriteJs } from '@shiro/browser/jsrewrite';
import { installShim } from '@shiro/browser/shim';
import { rewriteHtmlScripts } from '@shiro/browser/rewrite';
import { Broker, sriMatches } from '@shiro/browser/broker';
import { OriginMap } from '@shiro/browser/origin-map';
import { CookieJar } from '@shiro/browser/cookies';
import type { FetchMsg } from '@shiro/browser/protocol';

// The real vm (the test config polyfills node:vm for the browser)
const vm = createRequire(import.meta.url)('vm') as typeof import('node:vm');
const map = new OriginMap('https://{key}.tc.example');
const BROWSE = 'https://login-example-com.tc.example';

describe('jsrewrite', () => {
  const rw = (s: string, as?: 'script' | 'module' | 'body') => rewriteJs(s, as).code;

  it('renames location references and members, not keys, labels or export names', () => {
    expect(rw('location.hostname')).toBe('__tcLocation.hostname');
    expect(rw('window.location.href = u; document.location.reload()')).toBe('window.__tcLocation.href = u; document.__tcLocation.reload()');
    expect(rw('a?.location')).toBe('a?.__tcLocation');
    expect(rw('x = {location: 1, ["location"]: 2}; y.location')).toBe('x = {location: 1, ["location"]: 2}; y.__tcLocation');
    expect(rw('class A { location() {} static location = 1 }; location: for(;;) break location;')).toBe('class A { location() {} static location = 1 }; location: for(;;) break location;');
    expect(rw('delete o.location')).toBe('delete o.location');
    expect(rw('x["location"]')).toBe('x["location"]');
  });

  it('keeps local bindings consistent and expands shorthand', () => {
    expect(rw('function f(location) { return location.x }')).toBe('function f(__tcLocation) { return __tcLocation.x }');
    expect(rw('const o = {location}')).toBe('const o = {location: __tcLocation}');
    expect(rw('const {location} = w')).toBe('const {location: __tcLocation} = w');
    expect(rw('const {location: l = 1} = w; l(location)')).toBe('const {location: l = 1} = w; l(__tcLocation)');
    expect(rw('let {location = d} = w')).toBe('let {location: __tcLocation = d} = w');
    expect(rw('import {location} from "m"; export {location}; export {location as loc} from "n"', 'module'))
      .toBe('import {location as __tcLocation} from "m"; export {__tcLocation as location}; export {location as loc} from "n"');
  });

  it('renames top, but .top only on windows', () => {
    expect(rw('if (top !== self) top.location = self.location')).toBe('if (__tcTop !== self) __tcTop.__tcLocation = self.__tcLocation');
    expect(rw('window.top.postMessage(m, "*"); parent.top; f.contentWindow.top')).toBe('window.__tcTop.postMessage(m, __tcPMO("*")); parent.__tcTop; f.contentWindow.__tcTop');
    expect(rw('el.style.top = "1px"; x = r.top; const {top} = r; ({top})')).toBe('el.style.top = "1px"; x = r.top; const {top: __tcTop} = r; ({top: __tcTop})');
  });

  it('wraps postMessage target origins and direct eval sources', () => {
    expect(rw('parent.postMessage(m, location.origin)')).toBe('parent.postMessage(m, __tcPMO(__tcLocation.origin))');
    expect(rw('w.postMessage(m, "https://x.example", [p])')).toBe('w.postMessage(m, __tcPMO("https://x.example"), [p])');
    expect(rw('port.postMessage(m)')).toBe('port.postMessage(m)');
    expect(rw('eval(s + "1")')).toBe('eval(__tcJS(s + "1"))');
  });

  it('leaves unparseable or uninteresting code alone and finds where a prelude goes', () => {
    expect(rw('this is not javascript location')).toBe('this is not javascript location');
    expect(rewriteJs('var a = 1').changed).toBe(false);
    const r = rewriteJs('"use strict";\n"x";location.href');
    expect(r.code.slice(0, r.preludeAt)).toBe('"use strict";\n"x";');
    expect(rewriteJs('import x from "y"; location.href').module).toBe(true);
    expect(rewriteJs('#!/usr/bin/env node\nlocation').preludeAt).toBe(20);
    expect(rw('return location.href', 'body')).toBe('return __tcLocation.href');
  });
});

/** A fresh realm with a Location-like object at the browse URL. */
function realm(href: string) {
  const ctx = vm.createContext({ URL });
  vm.runInContext(`
    class Location {
      constructor(h) { this._h = h; }
      get href() { return this._h; } set href(v) { this._h = new URL(v, this._h).href; }
      get origin() { return new URL(this._h).origin; } get protocol() { return new URL(this._h).protocol; }
      get host() { return new URL(this._h).host; } get hostname() { return new URL(this._h).hostname; }
      get port() { return new URL(this._h).port; } get pathname() { return new URL(this._h).pathname; }
      get search() { return new URL(this._h).search; } get hash() { return new URL(this._h).hash; }
      get [Symbol.toStringTag]() { return 'Location'; }
      assign(v) { this.href = v; }
    }
    globalThis.location = new Location(${JSON.stringify(href)});
    globalThis.location.ancestorOrigins = ['https://tc.example'];
    globalThis.document = { location: globalThis.location };
    globalThis.window = globalThis.self = globalThis;
    globalThis.top = { window: null, app: true };   // the desktop above the tab
    globalThis.top.window = globalThis.top;
  `, ctx);
  installShim(vm.runInContext('globalThis', ctx), map, 'https://tc.example');
  return (code: string) => vm.runInContext(rewriteJs(code, 'script').code, ctx);
}

describe('shim', () => {
  it('shows rewritten scripts the real URL and origin', () => {
    const run = realm(`${BROWSE}/common/login?x=1#h`);
    expect(run('location.hostname')).toBe('login.example.com');
    expect(run('window.location.origin')).toBe('https://login.example.com');
    expect(run('document.location.href')).toBe('https://login.example.com/common/login?x=1#h');
    expect(run('String(location)')).toBe('https://login.example.com/common/login?x=1#h');
    expect(run('location.pathname + location.search')).toBe('/common/login?x=1');
    expect(run('location === document.location')).toBe(true);
    expect(run('Object.prototype.toString.call(location)')).toBe('[object Location]');
    expect(run('origin')).toBe('https://login.example.com');
    expect(run('top === window && window.top === self')).toBe(true);
    expect(run('({ top: 3 }).top')).toBe(3);
  });

  it('leaves other objects’ location properties alone, and navigates through the real Location', () => {
    const run = realm(`${BROWSE}/`);
    expect(run('const o = {location: "NYC"}; [o.location, JSON.stringify(o)]')).toEqual(['NYC', '{"location":"NYC"}']);
    expect(run('const p = {}; p.location = 5; [p.location, Object.keys(p)]')).toEqual([5, ['location']]);
    expect(run('(function (location) { return location })(7)')).toBe(7);
    run('location.href = "/next"');
    expect(run('location.href')).toBe('https://login.example.com/next');
  });

  it('maps postMessage targets and rewrites eval sources', () => {
    const run = realm(`${BROWSE}/`);
    expect(run('__tcPMO("https://www.youtube.com")')).toBe('https://www-youtube-com.tc.example');
    expect(run('__tcPMO(location.origin)')).toBe(BROWSE);
    expect(run('[__tcPMO("*"), __tcPMO("/"), __tcPMO({ targetOrigin: "https://a.example" }).targetOrigin]')).toEqual(['*', '/', 'https://a-example.tc.example']);
    expect(run('eval("location.hostname")')).toBe('login.example.com');
  });
});

describe('HTML scripts', () => {
  it('rewrites inline scripts (with our nonce), handlers and javascript: links', () => {
    const html = `<script>if (location.hostname !== "x") go()</script><script type="application/ld+json">{"location":1}</script>`
      + `<button onclick="location.href=&quot;/a&quot;">b</button><a href="javascript:location.reload()">r</a><script nonce="site">location.x</script>`;
    const out = rewriteHtmlScripts(html, { baseUrl: 'https://login.example.com/', nonce: 'N' });
    expect(out).toContain('<script nonce="N">if (__tcLocation.hostname !== "x") go()</script>');
    expect(out).toContain('<script type="application/ld+json">{"location":1}</script>');
    expect(out).toContain('onclick="__tcLocation.href=&quot;/a&quot;"');
    expect(out).toContain('href="javascript:__tcLocation.reload()"');
    expect(out).toContain('<script nonce="site">__tcLocation.x</script>');
  });

  it('hands integrity hashes to the broker and drops them from the page', () => {
    const got: [string, string][] = [];
    const out = rewriteHtmlScripts('<script src="/app.js" integrity="sha384-abc" crossorigin></script><link rel="stylesheet" href="https://cdn.example/s.css" integrity="sha256-def">',
      { baseUrl: 'https://login.example.com/x/', onSri: (u, i) => got.push([u, i]) });
    expect(got).toEqual([['https://login.example.com/app.js', 'sha384-abc'], ['https://cdn.example/s.css', 'sha256-def']]);
    expect(out).toBe('<script src="/app.js" crossorigin></script><link rel="stylesheet" href="https://cdn.example/s.css">');
  });
});

describe('broker scripts', () => {
  const sri = (alg: string, s: string) => `${alg}-${createHash(alg).update(s).digest('base64')}`;

  it('checks integrity on the strongest algorithm', async () => {
    const b = new TextEncoder().encode('x');
    expect(await sriMatches(b, sri('sha384', 'x'))).toBe(true);
    expect(await sriMatches(b, `${sri('sha256', 'x')} ${sri('sha512', 'y')}`)).toBe(false);
    expect(await sriMatches(b, 'md5-whatever')).toBe(true);
  });

  function setup(routes: Record<string, { headers?: [string, string][]; body: string }>) {
    const tab: any = { id: 1, url: 'https://login.example.com/', partition: 'https://example.com', bytes: 0, requests: 0, frame: () => null,
      onUrl() {}, onTitle() {}, onFallback() {}, openTab() {} };
    const broker = new Broker({ map, app: 'https://tc.example', dial: async () => { throw new Error('no network'); }, jar: new CookieJar(), tabs: () => [tab] });
    (broker.fetcher as any).fetch = async (req: { url: string }) => {
      const r = routes[req.url];
      return { status: r ? 200 : 404, statusText: 'OK', headers: r?.headers ?? [], body: new Response(r?.body ?? '').body!, reusable: Promise.resolve(true), url: req.url, wireBytes: () => 0 };
    };
    const ctx: any = { tab, realOrigin: 'https://login.example.com', browseOrigin: BROWSE, url: 'https://login.example.com/', nested: false, win: null, ancestors: [], partition: 'https://example.com' };
    const msg = (o: Partial<FetchMsg>): FetchMsg => ({
      type: 'fetch', id: 1, url: 'https://login.example.com/', method: 'GET', headers: [], body: null, mode: 'no-cors', destination: 'script',
      credentials: 'same-origin', redirect: 'follow', referrer: '', referrerPolicy: '' as ReferrerPolicy, navigation: false, ...o,
    });
    const text = async (r: any) => (r.type === 'response' ? new TextDecoder().decode(r.body instanceof ArrayBuffer ? r.body : await new Response(r.body).arrayBuffer()) : r.message);
    return { broker, ctx, msg, text };
  }

  it('rewrites scripts and workers, but not other loads or requests that carry integrity', async () => {
    const js = '"use strict";if (location.host !== "login.example.com") throw 1';
    const t = setup({
      'https://login.example.com/a.js': { headers: [['Content-Type', 'application/javascript'], ['Content-Length', String(js.length)]], body: js },
      'https://login.example.com/w.js': { headers: [['Content-Type', 'text/javascript']], body: js },
      'https://login.example.com/d.json': { headers: [['Content-Type', 'application/json']], body: '{"location":1}' },
    });
    const a = await t.broker.fetch(t.ctx, t.msg({ url: 'https://login.example.com/a.js' }));
    expect(await t.text(a)).toBe('"use strict";if (__tcLocation.host !== "login.example.com") throw 1');
    expect(a.type === 'response' && a.headers.filter(([k]) => /content-(length|type)/i.test(k))).toEqual([['Content-Type', 'text/javascript; charset=utf-8']]);
    const w = await t.broker.fetch(t.ctx, t.msg({ url: 'https://login.example.com/w.js', destination: 'worker' }));
    expect(await t.text(w)).toBe('"use strict";importScripts("/__tc/shim.js");if (__tcLocation.host !== "login.example.com") throw 1');
    expect(await t.text(await t.broker.fetch(t.ctx, t.msg({ url: 'https://login.example.com/a.js', integrity: 'sha256-x' })))).toBe(js);
    expect(await t.text(await t.broker.fetch(t.ctx, t.msg({ url: 'https://login.example.com/d.json', destination: 'script' })))).toBe('{"location":1}');
  });

  it('refuses a script that fails the integrity its page declared', async () => {
    const js = 'location.href';
    const t = setup({
      'https://login.example.com/': { headers: [['Content-Type', 'text/html']], body: `<script src="/ok.js" integrity="${sri('sha384', js)}"></script><script src="/bad.js" integrity="${sri('sha384', 'other')}"></script>` },
      'https://login.example.com/ok.js': { body: js },
      'https://login.example.com/bad.js': { body: js },
    });
    const page = await t.text(await t.broker.fetch(t.ctx, t.msg({ destination: 'document', mode: 'navigate', navigation: true })));
    expect(page).not.toContain('integrity');
    expect(await t.text(await t.broker.fetch(t.ctx, t.msg({ url: 'https://login.example.com/ok.js' })))).toBe('__tcLocation.href');
    const bad = await t.broker.fetch(t.ctx, t.msg({ url: 'https://login.example.com/bad.js' }));
    expect(bad.type).toBe('error');
  });
});
