// Benchmark driver for docs/X86_ENGINES.md: boots Shiro in headless Chromium,
// copies static ELF fixtures into its filesystem and times shell commands.
//   BENCH_DIR=dir-with-binaries node chromium.mjs http://localhost:5199/ "./hello-go;./cpuloop 5000000"
// The page must be cross-origin isolated for the Blink engine (serve with
// COOP same-origin + COEP credentialless). Needs playwright-core.
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
const url = process.argv[2] || 'http://localhost:5199/';
const bins = {
  'hello-go': process.env.BENCH_DIR + '/hello-go',
  'nethttp': process.env.BENCH_DIR + '/nethttp',
  'hello-musl': process.env.BENCH_DIR + '/hello-musl',
  'hello-glibc': process.env.BENCH_DIR + '/hello-glibc',
  'cpuloop': process.env.BENCH_DIR + '/cpuloop',
  'cloop': process.env.BENCH_DIR + '/cloop',
  'arith': process.env.BENCH_DIR + '/arith',
  'go-tls': process.env.BENCH_DIR + '/go-tls',
  'gh': process.env.BENCH_DIR + '/gh',
};
const cmds = (process.argv[3] || 'hello-musl;hello-glibc;hello-go a b;nethttp;cpuloop 2000000').split(';');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/blink|error/i.test(t) && !/sys [01][(]/.test(t) && !/favicon/.test(t)) console.log('[console]', t.slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__shiro && window.__shiro.shell, null, { timeout: 60000 });
console.log('crossOriginIsolated =', await page.evaluate(() => crossOriginIsolated));
for (const [name, path] of Object.entries(bins)) {
  if (!existsSync(path)) continue;
  const b64 = readFileSync(path).toString('base64');
  await page.evaluate(async ([name, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await window.__shiro.fs.mkdir('/home/user/x', { recursive: true }).catch(() => {});
    await window.__shiro.fs.writeFile('/home/user/x/' + name, bytes, { mode: 0o755 });
  }, [name, b64]);
}
await page.evaluate(() => window.__shiro.fs.writeFile('/home/user/x/input.txt', 'hi from browser\n'));
for (const cmd of cmds) {
  const r = await page.evaluate(async (cmd) => {
    let out = '';
    const t0 = performance.now();
    const code = await window.__shiro.shell.execute('cd /home/user/x && ' + cmd, (s) => { out += s; }, (s) => { out += s; });
    return { code, out, ms: Math.round(performance.now() - t0) };
  }, cmd);
  console.log(`=== ${cmd}  exit=${r.code}  ${r.ms}ms\n${r.out.trim().split('\n').slice(0, 8).join('\n')}`);
}
await browser.close();
