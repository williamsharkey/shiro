import { it, expect } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';
import { readFileSync, readdirSync } from 'fs';
import { createTestShell } from './helpers';
// Issue 74: typescript's lib/_tsc.js failed to load (module transform rewrote its strings),
// and process.exit() during require() was reported as a load error.
const TS_ROOT = path.resolve(__dirname, '../../../node_modules/typescript');
it.skipIf(!existsSync(TS_ROOT + '/lib/_tsc.js'))('tsc from node_modules runs', async () => {
  const { shell, fs } = await createTestShell();
  const root = TS_ROOT;
  const dest = '/home/user/proj/node_modules/typescript';
  await fs.mkdir(dest + '/bin', { recursive: true });
  await fs.mkdir(dest + '/lib', { recursive: true });
  for (const f of ['package.json', 'bin/tsc']) await fs.writeFile(`${dest}/${f}`, readFileSync(`${root}/${f}`));
  for (const f of readdirSync(root + '/lib')) if (/^(_tsc|tsc)\.js$|^lib\.(es5|es2015.*|es2016.*|es2017.*|es2018.*|es2019.*|es2020.*|decorators.*|dom.*|webworker.importscripts|scripthost|esnext.*|es2021.*|es2022.*|es2023.*|es2024.*)\.d\.ts$|^lib\.d\.ts$/.test(f)) await fs.writeFile(`${dest}/lib/${f}`, readFileSync(`${root}/lib/${f}`));
  await fs.writeFile('/home/user/proj/a.ts', 'const x: number = 1;\nexport const y: string = x;\n');
  shell.cwd = '/home/user/proj'; shell.env.PWD = '/home/user/proj';
  const run = async (c: string) => {
    let o = '';
    await shell.execute(c, s => { o += s; }, s => { o += s; });
    return o.replace(/\r\n/g, '\n');
  };
  const version = JSON.parse(readFileSync(root + '/package.json', 'utf8')).version;
  expect(await run('node node_modules/typescript/bin/tsc --version')).toContain(`Version ${version}`);
  const out = await run('node node_modules/typescript/bin/tsc --noEmit --target es2020 --lib es2020 a.ts; echo EXIT=$?');
  expect(out).toContain("a.ts(2,14): error TS2322: Type 'number' is not assignable to type 'string'.");
  expect(out).toContain('EXIT=2');
}, 240000);
