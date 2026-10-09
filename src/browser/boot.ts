// /__tc/boot.js: the first document a browse origin shows (docs/BROWSER.md).
// Without a token (served by server.mjs on the first visit) it installs the
// origin's service worker and reloads. With one (the SW's navigation shell)
// it asks the app for a port, lets the SW perform the navigation through it,
// and replaces itself with the result.
import { OriginMap, parentAppOrigin, templateFromBrowseOrigin } from './origin-map';

const script = document.currentScript as HTMLScriptElement;
const APPS = (script.dataset.apps || '').split(/\s+/).filter(Boolean);
const APP = parentAppOrigin(APPS) || '';
const token = script.dataset.token || '';
const template = templateFromBrowseOrigin(location.origin);
const map = template ? new OriginMap(template) : null;

function show(text: string, real?: string) {
  const render = () => {
    document.body.style.cssText = 'font: 14px system-ui, sans-serif; margin: 40px; color: #444';
    document.body.textContent = text;
    if (real) {
      const p = document.createElement('p');
      const a = document.createElement('a');
      a.href = real; a.target = '_blank'; a.rel = 'noopener'; a.textContent = `Open ${real} in a real tab`;
      p.append(a);
      document.body.append(p);
    }
  };
  if (document.body) render(); else addEventListener('DOMContentLoaded', render);
}

function askApp(): Promise<MessagePort | null> {
  return new Promise((resolve) => {
    if (window.top === window || !APP) { resolve(null); return; }
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== APP || e.data?.tc !== 'port' || !e.ports[0]) return;
      removeEventListener('message', onMsg);
      resolve(e.ports[0]);
    };
    addEventListener('message', onMsg);
    window.top!.postMessage({ tc: 'hello', role: 'sw', url: map ? map.toReal(location.href) : location.href }, APP);
    setTimeout(() => resolve(null), 10_000);
  });
}

async function install() {
  if (!('serviceWorker' in navigator)) { show('This browser has no service workers, so the Browser app cannot show this page.'); return; }
  if (window.top === window || !APP) { show('This address belongs to the Browser app. Open it from there.'); return; }
  try {
    await navigator.serviceWorker.register(`/__tc/sw.js?apps=${encodeURIComponent(APPS.join(' '))}`, { scope: '/' });
  } catch (e) {
    show(`Could not start this page's service worker (${(e as Error).message}). Third-party storage may be blocked.`, map?.toReal(location.href));
    window.top?.postMessage({ tc: 'fallback', reason: 'no-service-worker', url: map?.toReal(location.href) }, APP);
    return;
  }
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true }));
  }
  location.reload();
}

async function navigate() {
  const sw = navigator.serviceWorker.controller;
  if (!sw) { location.reload(); return; }
  const port = await askApp();
  if (!port) { show('This address belongs to the Browser app. Open it from there.'); return; }
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data;
    if (d?.tc === 'nav-go') location.replace(d.url);
    else if (d?.tc === 'nav-retry') location.reload();
    else if (d?.tc === 'nav-error') show(`This page could not be loaded: ${d.message}`, d.fallback ? map?.toReal(location.href) : undefined);
    else if (d?.tc === 'nav-unproxyable') { show('This page can only open in a real browser tab.', d.url); window.top?.postMessage({ tc: 'fallback', reason: 'unproxyable', url: d.url }, APP); }
  });
  sw.postMessage({ tc: 'nav', token }, [port]);
}

if (token) void navigate(); else void install();
