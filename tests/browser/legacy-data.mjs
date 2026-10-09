// Data saved before the tabcomputer rename survives the first boot of the
// renamed build (src/legacy-storage.ts, docs/PROFILES.md "The rename").
// It seeds a `shiro-fs` filesystem database and `shiro-*` localStorage keys on
// the origin, boots the app, and checks the file and settings came through.
//
//   PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/legacy-data.mjs [URL]      (default http://localhost:5299/)
import { createRequire } from 'node:module';

// playwright: a local install, or the cloud image's (NODE_PATH=/opt/node-tools/node_modules)
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const url = process.argv[2] || 'http://localhost:5299/';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed++; };

// Seed from a same-origin page that doesn't boot the app
await page.goto(new URL('/favicon.svg', url).href);
await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('shiro-fs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'path' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const node = (path, text) => ({
    path, type: text === null ? 'dir' : 'file', content: text === null ? null : new TextEncoder().encode(text),
    mode: text === null ? 0o755 : 0o644, mtime: 1, ctime: 1, size: text?.length ?? 0,
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    for (const n of [node('/', null), node('/home', null), node('/home/user', null), node('/home/user/before-rename.txt', 'saved by shiro')]) tx.objectStore('files').put(n);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  localStorage.setItem('shiro-desktop-theme', 'light');
  localStorage.setItem('shiro_github_token', 'gho_dummy_for_test');
});

await page.goto(url);
await page.waitForFunction(() => window.__tabcomputer?.shell && window.__tabcomputer?.fs, null, { timeout: 120_000 });
const r = await page.evaluate(async () => {
  const fs = window.__tabcomputer.fs;
  const text = await fs.readFile('/home/user/before-rename.txt', 'utf8').catch((e) => `ERR ${e.message}`);
  const dbs = (await indexedDB.databases()).map((d) => d.name);
  return {
    text, dbs, same: window.__tabcomputer === window.__shiro,
    theme: localStorage.getItem('tabcomputer-desktop-theme'), token: localStorage.getItem('tabcomputer_github_token'),
    hostname: await fs.readFile('/etc/hostname', 'utf8').catch(() => ''),
  };
});
check(r.text === 'saved by shiro', `the file saved under shiro-fs reads back (${JSON.stringify(r.text)})`);
check(r.dbs.includes('tabcomputer-fs') && !r.dbs.includes('shiro-fs'), `shiro-fs moved to tabcomputer-fs (${r.dbs.filter((n) => /-fs$/.test(n)).join(', ')})`);
check(r.theme === 'light' && r.token === 'gho_dummy_for_test', 'shiro-* settings copied to tabcomputer-* names');
check(r.same, 'window.__tabcomputer is window.__shiro');
check(r.hostname === 'tabcomputer\n', `/etc/hostname is tabcomputer (${JSON.stringify(r.hostname)})`);

// A reload must not lose anything (the move happens once)
await page.reload();
await page.waitForFunction(() => window.__tabcomputer?.fs, null, { timeout: 120_000 });
const again = await page.evaluate(() => window.__tabcomputer.fs.readFile('/home/user/before-rename.txt', 'utf8').catch((e) => `ERR ${e.message}`));
check(again === 'saved by shiro', 'still there after a reload');

await browser.close();
process.exit(failed ? 1 : 0);
