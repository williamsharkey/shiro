// Builtins that load WebAssembly on first use, with the CDNs they used refused:
// sqlite3 (sql.js), convert/magick (magick-wasm, the DejaVu Sans fallback font)
// and build (esbuild-wasm) load from tabcomputer's own origin.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/no-cdn.mjs [URL]
//
// Prints one line per case with its time; exits 1 if a case fails or a CDN was asked.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const url = process.argv[2] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const context = await browser.newContext();
const cdn = [];
await context.route(/^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|esm\.sh)\//, (r) => { cdn.push(r.request().url()); return r.abort(); });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__tabcomputer?.shell, null, { timeout: 90_000 });

const run = (cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const sh = window.__cdnShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await sh.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { code, out: out.replace(/\r\n/g, '\n') };
}, cmd);

let failed = 0;
async function check(name, cmd, want) {
  const t0 = Date.now();
  const r = await run(cmd);
  const ok = r.code === 0 && want.test(r.out);
  if (!ok) failed++;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${name}${ok ? '' : `\n  exit ${r.code}: ${r.out.trim().split('\n').slice(-4).join('\n  ')}`}`);
}

await check('sqlite3 (sql.js)', `sqlite3 :memory: "select 6*7, sqlite_version();"`, /42\|3\.\d+/);
await check('convert, text in the default font (magick-wasm, DejaVu Sans)', 'convert -size 80x24 xc:navy -fill white -pointsize 14 -annotate +4+17 hello /tmp/nc.png && magick identify /tmp/nc.png', /nc\.png PNG 80x24/);
await check('build (esbuild-wasm)', `mkdir -p /tmp/nb && echo 'const n: number = 41; console.log(n + 1);' > /tmp/nb/a.ts && cd /tmp/nb && build a.ts --outfile=out.js > /dev/null && node out.js`, /^42$/m);
if (cdn.length) { failed++; console.log(`FAIL  a CDN was asked: ${cdn.join(', ')}`); }

await browser.close();
process.exit(failed ? 1 : 0);
