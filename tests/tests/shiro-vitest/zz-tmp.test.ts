import { it } from 'vitest';
import { createTestShell } from './helpers';
it('x', async () => {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/home/user/dd', { recursive: true });
  await fs.writeFile('/home/user/dd/dev.mjs', `export default async function dev() { return 'dev'; }\n`);
  await fs.writeFile('/home/user/dd/other.mjs', `export function other() { return 1; }\n`);
  await fs.writeFile('/home/user/dd/index.mjs', `import { default as default2 } from "./dev.mjs";\nimport { other } from "./other.mjs";\nexport {\n  other,\n  default2 as default\n};\n`);
  await fs.writeFile('/home/user/dd/main.mjs', `import d, { other } from './index.mjs';\nconsole.log(typeof d, typeof other);\n`);
  let out = '';
  await shell.execute('cd /home/user/dd && node main.mjs', (s) => { out += s; }, (s) => { out += s; });
  console.log('OUT', JSON.stringify(out));
  const { transformESModules } = await import('@shiro/commands/jseval/module-transform');
  console.log('T', transformESModules(await fs.readFile('/home/user/dd/index.mjs', 'utf8') as string));
});
