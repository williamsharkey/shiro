/**
 * What the Browser app's broker changes in proxied documents
 * (src/browser/rewrite.ts, docs/BROWSER.md "What the broker changes").
 */
import { describe, expect, it } from 'vitest';
import { framingAllowed, rewriteCsp, rewriteHtml, sniffCharset } from '@shiro/browser/rewrite';
import { OriginMap } from '@shiro/browser/origin-map';

const map = new OriginMap('https://{key}.tabcomputer.com');
const tag = '<script src="/__tc/client.js" nonce="N"></script>';

describe('CSP', () => {
  const o = { nonce: 'N', realOrigin: 'https://www.example.com' };
  it("adds the real origin to 'self' and our nonce to script-src", () => {
    expect(rewriteCsp("default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; img-src *; frame-ancestors 'none'; report-uri /r", o))
      .toBe("default-src 'self' https://www.example.com; script-src 'self' 'nonce-abc' 'strict-dynamic' https://www.example.com 'nonce-N'; img-src *");
  });
  it('puts the nonce in default-src when there is no script-src', () => {
    expect(rewriteCsp("default-src https://cdn.example", o)).toBe("default-src https://cdn.example 'nonce-N'");
    expect(rewriteCsp("default-src 'none'", o)).toBe("default-src 'nonce-N'");
  });
  it('drops directives that cannot work on a browse origin', () => {
    expect(rewriteCsp('sandbox allow-scripts; require-trusted-types-for \'script\'', o)).toBeNull();
    expect(rewriteCsp("script-src 'none'", o)).toBe("script-src 'nonce-N'");
  });
});

describe('HTML', () => {
  const base = 'https://www.example.com/dir/page.html';
  it('injects the runtime first in <head>, after <meta charset>', () => {
    expect(rewriteHtml('<!doctype html><html><head><meta charset="utf-8"><title>x</title></head></html>', { map, baseUrl: base, scriptTag: tag }))
      .toBe(`<!doctype html><html><head><meta charset="utf-8">${tag}<title>x</title></head></html>`);
    expect(rewriteHtml('<!DOCTYPE html><p>no head', { map, baseUrl: base, scriptTag: tag })).toBe(`<!DOCTYPE html>${tag}<p>no head`);
  });
  it('points absolute links, forms, frames and meta refresh at browse origins; leaves relative URLs and subresources', () => {
    const out = rewriteHtml(`<head></head><a href="https://other.org/x?a=1&amp;b=2">o</a><a href='/rel'>r</a><a href=//cdn.example.net/y>p</a>
<form action="https://login.example.com/post" method=post></form><iframe src="https://www.youtube.com/embed/abc"></iframe>
<img src="https://img.example.com/i.png"><meta http-equiv="refresh" content="0; url=https://next.example/">`, { map, baseUrl: base, scriptTag: tag });
    expect(out).toContain('href="https://other-org.tabcomputer.com/x?a=1&amp;b=2"');
    expect(out).toContain("href='/rel'");
    expect(out).toContain('href="https://cdn-example-net.tabcomputer.com/y"');
    expect(out).toContain('action="https://login-example-com.tabcomputer.com/post"');
    expect(out).toContain('src="https://www-youtube-com.tabcomputer.com/embed/abc"');
    expect(out).toContain('src="https://img.example.com/i.png"');
    expect(out).toContain('url=https://next-example.tabcomputer.com/');
  });
  it('drops <meta http-equiv=Content-Security-Policy> and keeps non-ASCII bytes', () => {
    const latin1 = '<head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></head>café ÿ';
    const out = rewriteHtml(latin1, { map, baseUrl: base, scriptTag: tag });
    expect(out).not.toContain('Content-Security-Policy');
    expect(out).toContain('café ÿ');
  });
  it('sniffs <meta charset>', () => {
    expect(sniffCharset('<html><head><meta charset="Shift_JIS">')).toBe('shift_jis');
    expect(sniffCharset('<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">')).toBe('windows-1251');
    expect(sniffCharset('<p>none')).toBeNull();
  });
});

describe('framing of nested documents', () => {
  const me = 'https://bank.example';
  it('honours X-Frame-Options', () => {
    expect(framingAllowed([['X-Frame-Options', 'DENY']], me, [me])).toBe(false);
    expect(framingAllowed([['X-Frame-Options', 'SAMEORIGIN']], me, [me])).toBe(true);
    expect(framingAllowed([['X-Frame-Options', 'SAMEORIGIN']], me, ['https://evil.example'])).toBe(false);
    expect(framingAllowed([], me, ['https://evil.example'])).toBe(true);
  });
  it('honours frame-ancestors over X-Frame-Options', () => {
    const csp = (v: string): [string, string][] => [['Content-Security-Policy', v], ['X-Frame-Options', 'DENY']];
    expect(framingAllowed(csp("frame-ancestors 'self'"), me, [me])).toBe(true);
    expect(framingAllowed(csp("frame-ancestors 'self'"), me, [me, 'https://evil.example'])).toBe(false);
    expect(framingAllowed(csp('frame-ancestors https://*.partner.com'), me, ['https://a.partner.com'])).toBe(true);
    expect(framingAllowed(csp("frame-ancestors 'none'"), me, [me])).toBe(false);
    expect(framingAllowed(csp("frame-ancestors 'self'"), me, [null])).toBe(false);
  });
});
