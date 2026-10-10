// Developer tools on the desktop (docs/DESKTOP.md "Developer tools", "Git"), in Chromium:
//   dock       Developer and AI agents: nano, Vim, Code, Git and Claude Code loose, the rest in two stacks
//   install    a tool that isn't installed shows ↓, installs in its Terminal on the first click
//              (ring on the tile meanwhile), then runs (Vim, from pkg)
//   badges     in a repository Files shows the branch, ahead/behind and each entry's status
//   git app    stage, unstage and commit; the badges follow (no polling: fs changes)
//   branches   New Branch Folder makes ~/src/OWNER/REPO@BRANCH with git worktree (real git
//              installed on first use), and Files tags each folder with its branch
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/dev-tools.mjs [URL] [--shots DIR]
//
// Needs the server's package index (pkg install vim, git). Exits 1 if any check fails.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch {
  try { pw = require('/opt/node-tools/node_modules/playwright'); } catch { pw = require('playwright-core'); }
}
const { chromium } = pw;
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const url = args[0] || 'http://localhost:5299/';
if (shots) mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
for (const theme of shots ? ['dark', 'light'] : ['dark']) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })).newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const shot = async (sel, name) => { if (shots) await (await page.$(sel)).screenshot({ path: join(shots, `${name}-${theme}.png`) }); };
  const sh = (cmd) => page.evaluate(async (cmd) => { let o = ''; const s = window.__tabcomputer.shell.fork(); s.cwd = '/home/user'; const code = await s.execute(cmd, x => { o += x; }, x => { o += x; }); return { code, o }; }, cmd);
  const screen = () => page.evaluate(() => { const v = window.__shiroDesktop.focused()?.content; const t = (v?.activeTerminal?.() ?? window.__tabcomputer.terminal).term; const b = t.buffer.active; const rows = []; for (let y = 0; y < t.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? ''); return rows.join('\n'); });

  // ── dock ──
  const dock = await page.$$eval('.sd-dock > .sd-dock-item', els => els.map(e => e.dataset.app ?? `[${e.dataset.group}]`));
  const want = ['nano', 'vim', 'code', 'git', '[developer]', 'claude', '[agents]'];
  check(`${theme}: dock`, want.every((x, i) => dock.indexOf(x) >= 0 && (i === 0 || dock.indexOf(x) > dock.indexOf(want[i - 1]))), dock.join(' '));
  await shot('.sd-dock', 'dev-dock');
  for (const g of ['developer', 'agents']) {
    await page.click(`.sd-stack-tile[data-group=${g}]`);
    const items = await page.$$eval('.sd-stack .sd-stack-name', els => els.map(e => e.textContent));
    check(`${theme}: ${g} stack`, items.length === (g === 'developer' ? 4 : 5), items.join(', '));
    await shot('.sd-stack', `dev-stack-${g}`);
    await page.mouse.click(700, 300);
  }

  // ── install on first use (once per profile: the light pass finds Vim installed) ──
  if (theme === 'dark') {
    const before = await page.$eval('.sd-dock-item[data-app=vim]', e => e.className);
    check('vim offered for install', before.includes('sd-not-installed'), before);
    await page.click('.sd-dock-item[data-app=vim]');
    const t0 = Date.now();
    await page.waitForFunction(() => /VIM - Vi IMproved|~\s*$/m.test(document.body.innerText) || !!document.querySelector('.sd-dock-item[data-app=vim]:not(.sd-installing):not(.sd-not-installed)'), null, { timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const s = await screen();
    const tile = await page.$eval('.sd-dock-item[data-app=vim]', e => e.className);
    check('vim installs, then runs', /isn't installed yet: pkg install vim/.test(s) || /VIM - Vi IMproved|^~/m.test(s), `${Date.now() - t0} ms, tile "${tile}"`);
    check('vim tile no longer offers install', !tile.includes('sd-not-installed') && !tile.includes('sd-installing'), tile);
    await page.keyboard.type(':q!\n');
  }

  // ── a repository with changes ──
  const repo = `/home/user/src/demo/hello-${theme}`;
  const r = await sh(`mkdir -p ${repo} && cd ${repo} && git init -q && printf 'print("hello")\\n' > hello.py && printf '# Hello\\n' > README.md && mkdir src && printf 'x = 1\\n' > src/util.py && git add . && git commit -q -m "First commit" && printf 'y = 2\\n' >> src/util.py && git add . && git commit -q -m "Add y" && mkdir -p .git/refs/remotes/origin && git log --format=%H | tail -1 > .git/refs/remotes/origin/main && printf 'print("hello, world")\\n' > hello.py && printf 'notes\\n' > notes.txt && printf 'z = 3\\n' > src/new.py && git add src/new.py`);
  check(`${theme}: repo set up`, r.code === 0, r.o.slice(-200));
  await page.evaluate((p) => window.__shiroDesktop.openApp('files', { path: p, newWindow: true }), repo);
  await page.waitForSelector('.sd-git-chip:not([hidden]) .sd-git-branch');
  await page.waitForTimeout(1200);
  const badges = await page.$$eval('.sd-win.sd-focused .sd-git-badge', els => els.map(e => `${e.closest('tr').dataset.path.split('/').pop()}:${e.textContent}`).sort().join(' '));
  check(`${theme}: Files badges`, badges === 'hello.py:M notes.txt:U src:M', badges);
  const chip = await page.$eval('.sd-win.sd-focused .sd-git-chip', e => e.textContent.trim());
  check(`${theme}: branch and ahead`, chip === 'main↑1', chip);
  await shot('.sd-win.sd-focused', 'dev-files-repo');

  // ── the Git app: stage, commit; the badges follow ──
  await page.click('.sd-win.sd-focused .sd-git-branch');
  await page.waitForSelector('.sd-gitui .sd-git-file');
  await page.waitForTimeout(800);
  const lists = () => page.$$eval('.sd-gitui .sd-git-file', els => els.map(e => `${e.dataset.kind}:${e.dataset.path}`).join(' '));
  check(`${theme}: Git app lists`, (await lists()) === 'staged:src/new.py changed:hello.py untracked:notes.txt', await lists());
  await shot('.sd-win.sd-focused', 'dev-git-app');
  await page.click('.sd-gitui .sd-git-file[data-path="hello.py"] [data-toggle]');
  await page.waitForFunction(() => !!document.querySelector('.sd-gitui .sd-git-file[data-kind=staged][data-path="hello.py"]'), null, { timeout: 10_000 }).catch(() => {});
  check(`${theme}: stage`, (await lists()).includes('staged:hello.py'), await lists());
  await page.fill('.sd-gitui textarea[name=msg]', 'Say hello to the world');
  await page.click('.sd-gitui .sd-git-commit button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('.sd-gitui .sd-git-file[data-kind=staged]'), null, { timeout: 10_000 }).catch(() => {});
  const log = await sh(`cd ${repo} && git log --format=%s -1 && git status --short`);
  check(`${theme}: commit`, /Say hello to the world/.test(log.o) && /\?\? notes\.txt/.test(log.o) && !/hello\.py/.test(log.o), log.o.replace(/\s+/g, ' '));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => [...document.querySelectorAll('.sd-win')].map(w => w.querySelector('.sd-git-chip')?.textContent?.trim()).filter(Boolean).join(','));
  check(`${theme}: Files follows the commit`, after.includes('main↑2'), after);

  // ── branch folder (dark only: real git installs once) ──
  if (theme === 'dark') {
    await page.evaluate((p) => window.__shiroDesktop.openApp('files', { path: p, newWindow: true }), repo);
    await page.waitForSelector('.sd-win.sd-focused [data-act=branchfolder]:not([hidden])');
    await page.click('.sd-win.sd-focused [data-act=branchfolder]');
    await page.fill('.sd-git-sheet input[name=branch]', 'feature/json');
    await page.waitForTimeout(300);
    await shot('.sd-git-sheet', 'dev-branch-sheet');
    await page.click('.sd-git-sheet button[type=submit]');
    await page.waitForFunction((p) => window.__tabcomputer.fs.exists(`${p}@feature-json/hello.py`), repo, { timeout: 120_000, polling: 500 }).catch(() => {});
    await page.waitForTimeout(2000);
    const s = await screen();
    check('branch folder made by git worktree', /Preparing worktree \(new branch 'feature\/json'\)/.test(s), s.split('\n').filter(Boolean).slice(-3).join(' / '));
    await page.evaluate(() => window.__shiroDesktop.openApp('files', { path: '/home/user/src/demo', newWindow: true }));
    await page.waitForTimeout(2500);
    const tags = await page.$$eval('.sd-win.sd-focused .sd-git-repo', els => els.map(e => `${e.closest('tr').dataset.path.split('/').pop()}=${e.textContent}`).join(' '));
    check('Files tags branch folders', tags.includes('hello-dark=main↑2') && tags.includes('hello-dark@feature-json=feature/json'), tags);
    await shot('.sd-win.sd-focused', 'dev-files-branches');
    // The Clone sheet (not run: no network to GitHub here)
    await page.click('.sd-win.sd-focused [data-act=clone]');
    await page.fill('.sd-git-sheet input[name=repo]', 'https://github.com/octocat/Hello-World');
    await page.waitForTimeout(300);
    const dest = await page.$eval('.sd-git-sheet .sd-git-dest', e => e.textContent);
    check('Clone sheet reads URLs', dest === 'Into ~/src/octocat/Hello-World', dest);
    await shot('.sd-git-sheet', 'dev-clone-sheet');
    await page.keyboard.press('Escape');
  }
  await page.context().close();
}
await browser.close();
const failed = results.filter(x => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
