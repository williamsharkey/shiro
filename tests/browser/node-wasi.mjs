// node:wasi in the real app (node as a kernel guest in a Worker): a WASI
// command module through node's WASI class, then napi-rs's WebAssembly
// binding of rolldown (emnapi threads on worker_threads, shared memory)
// from npm: its sync and async APIs, and a rolldown bundle.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/node-wasi.mjs [URL]
//
// Prints one line per case with its time; exits 1 if any case fails. The
// rolldown cases fetch from registry.npmjs.org (through $HTTPS_PROXY when set).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const url = process.argv[2] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const here = path.dirname(new URL(import.meta.url).pathname);
const fixtures = path.join(here, '../tests/shiro-vitest/fixtures/wasi');
const ROLLDOWN = '1.2.13';

const proxy = process.env.HTTPS_PROXY ? process.env.HTTPS_PROXY.replace(/^\w+:\/\//, '').replace(/\/$/, '') : '';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', ...(proxy ? [`--proxy-server=${proxy}`] : [])] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: !!proxy })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__tabcomputer?.shell, null, { timeout: 90_000 });

const write = (file, data) => page.evaluate(async ([file, b64]) => {
  const fs = window.__tabcomputer.fs;
  await fs.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(file, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}, [file, Buffer.from(data).toString('base64')]);
/** A command in a terminal-less shell (kept across cases): its output and status */
const run = (cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const sh = window.__wasiShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await sh.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { code, out: out.replace(/\r\n/g, '\n') };
}, cmd);

let failed = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${name}\n${String(e.message).split('\n').map((l) => '  ' + l).join('\n')}`);
  }
}
const expectOut = (r, want) => { if (r.out !== want) throw new Error(`exit ${r.code}, output:\n${r.out}\nwanted:\n${want}`); };

await check('a WASI command module: stdout, a preopen, its exit code', async () => {
  for (const f of ['fdwrite.wasm', 'cat.wasm']) await write(`/tmp/nw/${f}`, readFileSync(path.join(fixtures, f)));
  await write('/tmp/nw/root/in.txt', 'one\ntwo\n');
  await write('/tmp/nw/run.js', `const { WASI } = require('node:wasi'); const fs = require('fs');
const run = (file, opts) => {
  const wasi = new WASI({ version: 'preview1', ...opts });
  return wasi.start(new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(file)), wasi.getImportObject()));
};
console.log('status', run('/tmp/nw/fdwrite.wasm', { args: ['fdwrite', '1', 'hi'] }));
console.log('status', run('/tmp/nw/cat.wasm', { args: ['cat', '/in.txt'], preopens: { '/': '/tmp/nw/root' } }));
`);
  expectOut(await run('node /tmp/nw/run.js < /dev/null'), 'hi\nstatus 0\none\ntwo\nstatus 0\n');
});

await check(`rolldown's WebAssembly binding (@rolldown/binding-wasm32-wasi ${ROLLDOWN}): sync and async (threads) APIs`, async () => {
  const r = await run(`mkdir -p /tmp/rw && cd /tmp/rw && npm init -y > /dev/null && npm i @rolldown/binding-wasm32-wasi@${ROLLDOWN} @oxc-project/types @rolldown/pluginutils > /dev/null 2>&1; echo $?`);
  if (r.out.trim() !== '0') throw new Error(`npm i: ${r.out}`);
  await write('/tmp/rw/t.js', `const b = require('@rolldown/binding-wasm32-wasi');
console.log(b.transformSync('a.ts', 'const a: number = 1', {}).code.trim());
b.transform('b.ts', 'const b: string = "x"', {}).then((r) => { console.log(r.code.trim()); process.exit(0); });
setTimeout(() => { console.log('async transform timed out'); process.exit(1); }, 30000);
`);
  expectOut(await run('cd /tmp/rw && node t.js < /dev/null'), 'const a = 1;\nconst b = "x";\n');
});

await check(`a rolldown ${ROLLDOWN} bundle on that binding (rolldown's node build)`, async () => {
  // (npm installs rolldown's browser build under its name; the node build comes from its tarball)
  const r = await run(`cd /tmp/rw && curl -sL https://registry.npmjs.org/rolldown/-/rolldown-${ROLLDOWN}.tgz -o /tmp/rolldown.tgz && mkdir -p /tmp/rdx && tar xzf /tmp/rolldown.tgz -C /tmp/rdx && rm -rf node_modules/rolldown && mv /tmp/rdx/package node_modules/rolldown; echo $?`);
  if (r.out.trim() !== '0') throw new Error(`rolldown tarball: ${r.out}`);
  await write('/tmp/rw/src/a.js', "import { b } from './b.js';\nconsole.log(b * 2);\n");
  await write('/tmp/rw/src/b.js', 'export const b = 21;\nexport const unused = 1;\n');
  await write('/tmp/rw/b.mjs', `import { rolldown } from 'rolldown';
const bundle = await rolldown({ input: 'src/a.js' });
const { output } = await bundle.generate({ format: 'esm' });
console.log(output[0].code.replace(/\\/\\/#(end)?region.*\\n/g, '').trim());
await bundle.close();
`);
  expectOut(await run('cd /tmp/rw && timeout 120 node b.mjs < /dev/null'), 'console.log(42);\n');
});

await browser.close();
process.exit(failed ? 1 : 0);
