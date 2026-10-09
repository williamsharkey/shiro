/**
 * The Browser app's broker (src/browser/broker.ts): the security rules it
 * enforces for proxied documents, with the network replaced by a fake.
 */
import { describe, expect, it } from 'vitest';
import { Broker } from '@shiro/browser/broker';
import { OriginMap } from '@shiro/browser/origin-map';
import { CookieJar } from '@shiro/browser/cookies';
import type { FetchMsg } from '@shiro/browser/protocol';

type Sent = { url: string; method: string; headers: [string, string][] };

function setup(routes: Record<string, { status?: number; headers?: [string, string][]; body?: string }>) {
  const jar = new CookieJar();
  const sent: Sent[] = [];
  const tab: any = { id: 1, url: 'https://site.example/', partition: 'https://site.example', bytes: 0, requests: 0, frame: () => null,
    onUrl() {}, onTitle() {}, onFallback(r: string) { tab.fallbacks.push(r); }, openTab() {}, fallbacks: [] as string[] };
  const broker = new Broker({ map: new OriginMap('https://{key}.tc.example'), app: 'https://tc.example', dial: async () => { throw new Error('no network'); }, jar, tabs: () => [tab] });
  (broker.fetcher as any).fetch = async (req: { url: string; method: string; headers: [string, string][] }) => {
    sent.push({ url: req.url, method: req.method, headers: req.headers });
    const r = routes[`${req.method} ${req.url}`] ?? routes[req.url] ?? { status: 404 };
    const body = new Response(r.body ?? '').body!;
    return { status: r.status ?? 200, statusText: 'OK', headers: r.headers ?? [], body, reusable: Promise.resolve(true), url: req.url, wireBytes: () => 0 };
  };
  const ctx = (o: Partial<any> = {}) => ({
    tab, realOrigin: 'https://site.example', browseOrigin: 'https://site-example.tc.example', url: 'https://site.example/', nested: false,
    win: null, ancestors: [], partition: 'https://site.example', ...o,
  });
  const msg = (o: Partial<FetchMsg>): FetchMsg => ({
    type: 'fetch', id: 1, url: 'https://site.example/', method: 'GET', headers: [], body: null, mode: 'cors', destination: '' as RequestDestination,
    credentials: 'same-origin', redirect: 'follow', referrer: 'https://site.example/', referrerPolicy: '' as ReferrerPolicy, navigation: false, ...o,
  });
  jar.setFromResponse(new URL('https://bank.example/'), ['session=s3cret; Path=/; Secure; SameSite=None'], { partition: 'https://site.example', initiatorSite: null, topLevelNavigation: true, method: 'GET' });
  jar.setFromResponse(new URL('https://site.example/'), ['mine=1; Path=/'], { partition: 'https://site.example', initiatorSite: null, topLevelNavigation: true, method: 'GET' });
  const header = (s: Sent, n: string) => s.headers.find(([k]) => k.toLowerCase() === n)?.[1];
  return { broker, jar, sent, tab, ctx, msg, header };
}

describe('broker', () => {
  it('sends no cookies with cross-origin no-cors requests, and reads stay uncredentialed', async () => {
    const t = setup({ 'https://bank.example/account': { body: 'balance' } });
    const r = await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://bank.example/account', mode: 'no-cors', credentials: 'include' }));
    expect(r.type).toBe('response');
    expect(t.header(t.sent[0], 'cookie')).toBeUndefined();
  });

  it('sends cookies cross-origin only for CORS with credentials, and enforces the answer', async () => {
    const t = setup({
      'https://bank.example/api': { headers: [['Access-Control-Allow-Origin', 'https://site.example'], ['Access-Control-Allow-Credentials', 'true']], body: '{}' },
      'https://bank.example/private': { headers: [['Access-Control-Allow-Origin', 'https://other.example']], body: 'no' },
      'https://bank.example/star': { headers: [['Access-Control-Allow-Origin', '*']], body: 'public' },
    });
    const ok = await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://bank.example/api', credentials: 'include' }));
    expect(t.header(t.sent[0], 'cookie')).toBe('session=s3cret');
    expect(t.header(t.sent[0], 'origin')).toBe('https://site.example');
    expect(ok.type === 'response' && ok.headers.find(([k]) => k === 'Access-Control-Allow-Origin')?.[1]).toBe('https://site-example.tc.example');
    const denied = await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://bank.example/private' }));
    expect(denied.type).toBe('error');
    // * never satisfies a credentialed request
    expect((await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://bank.example/star', credentials: 'include' }))).type).toBe('error');
    expect((await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://bank.example/star' }))).type).toBe('response');
  });

  it('preflights non-simple CORS requests and refuses what the server does not allow', async () => {
    const t = setup({
      'OPTIONS https://api.example/x': { status: 204, headers: [['Access-Control-Allow-Origin', 'https://site.example'], ['Access-Control-Allow-Methods', 'PUT'], ['Access-Control-Allow-Headers', 'x-token']] },
      'PUT https://api.example/x': { headers: [['Access-Control-Allow-Origin', 'https://site.example']], body: 'done' },
    });
    const r = await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://api.example/x', method: 'PUT', headers: [['x-token', '1']] }));
    expect(r.type).toBe('response');
    expect(t.sent.map((s) => s.method)).toEqual(['OPTIONS', 'PUT']);
    const bad = await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://api.example/x', method: 'DELETE' }));
    expect(bad.type).toBe('error');
  });

  it('uses the partition bound to the port, not the tab’s current site', async () => {
    const t = setup({ 'https://bank.example/': {} });
    t.tab.partition = 'https://bank.example'; // the tab moved on; this port belongs to an old document
    await t.broker.fetch(t.ctx({ partition: 'https://evil.example', realOrigin: 'https://evil.example' }) as any,
      t.msg({ url: 'https://bank.example/', credentials: 'include', mode: 'cors' }));
    expect(t.header(t.sent[0], 'cookie')).toBeUndefined();
  });

  it('only navigates the port’s own origin, and stores cookies from it', async () => {
    const t = setup({ 'https://site.example/login': { headers: [['Content-Type', 'text/html'], ['Set-Cookie', 'sid=1; Path=/; Secure']], body: '<html><head></head>hi</html>' } });
    const other = await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://bank.example/', navigation: true }));
    expect(other.type).toBe('error');
    const r = await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://site.example/login', navigation: true, mode: 'navigate' as RequestMode }));
    expect(r.type).toBe('response');
    if (r.type !== 'response') return;
    const html = new TextDecoder().decode(r.body as ArrayBuffer);
    expect(html).toMatch(/<head><script src="\/__tc\/client\.js" nonce="[0-9a-f]+" data-app="https:\/\/tc\.example" data-cookie="mine=1; sid=1"><\/script>/);
    expect(r.headers).toContainEqual(['Cross-Origin-Embedder-Policy', 'credentialless']);
    expect(r.headers).toContainEqual(['Content-Security-Policy', 'frame-ancestors https://tc.example https://*.tc.example']);
    expect(r.headers.some(([k]) => k.toLowerCase() === 'set-cookie')).toBe(false);
    expect(t.jar.cookieHeader(new URL('https://site.example/'), { partition: 'https://site.example', initiatorSite: 'https://site.example', topLevelNavigation: false, method: 'GET' })).toContain('sid=1');
  });

  it('refuses nested documents that forbid framing, and offers a real tab for Google sign-in', async () => {
    const t = setup({ 'https://bank.example/': { headers: [['X-Frame-Options', 'DENY'], ['Content-Type', 'text/html']], body: '<p>bank' } });
    const nested = t.ctx({ realOrigin: 'https://bank.example', nested: true, ancestors: ['https://site.example'] });
    const r = await t.broker.fetch(nested as any, t.msg({ url: 'https://bank.example/', navigation: true }));
    expect(r.type === 'error' && r.fallback).toBe('frame-denied');
    const g = await t.broker.fetch(t.ctx({ realOrigin: 'https://accounts.google.com' }) as any, t.msg({ url: 'https://accounts.google.com/signin', navigation: true }));
    expect(g.type === 'error' && g.fallback).toBe('google-signin');
    expect(t.tab.fallbacks).toEqual(['google-signin']);
  });

  it('returns navigation redirects to the shell and follows subresource redirects', async () => {
    const t = setup({
      'https://site.example/old': { status: 301, headers: [['Location', '/new']] },
      'https://site.example/new': { body: 'here' },
    });
    const nav = await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://site.example/old', navigation: true }));
    expect(nav).toMatchObject({ type: 'redirect', location: 'https://site.example/new' });
    const sub = await t.broker.fetch(t.ctx() as any, t.msg({ url: 'https://site.example/old' }));
    expect(sub).toMatchObject({ type: 'response', url: 'https://site.example/new', redirected: true });
  });
});
