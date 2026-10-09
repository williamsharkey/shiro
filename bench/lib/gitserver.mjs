// A git:// server on this machine for the clone-over-the-relay workload.
// The repository is generated deterministically (same commit every run) in
// bench/.cache/gitsrv: 40 small files, a 2000-line file and 5 commits.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { freePort } from './servers.mjs';

const REPO = 'small.git';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.com', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
  });
}

function ensureRepo(base) {
  const bare = join(base, REPO);
  if (existsSync(join(bare, 'HEAD'))) return bare;
  const work = join(base, 'work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'src'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  for (let c = 0; c < 5; c++) {
    for (let i = 0; i < 40; i++) writeFileSync(join(work, `f${i}.txt`), `file ${i} rev ${c}\n`.repeat(10));
    writeFileSync(join(work, 'src', 'data.txt'), Array.from({ length: 2000 }, (_, i) => `line ${i} rev ${c}`).join('\n') + '\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `commit ${c}`);
  }
  git(base, 'clone', '-q', '--bare', work, REPO);
  rmSync(work, { recursive: true, force: true });
  return bare;
}

export async function startGitDaemon({ cacheDir, log }) {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { log?.('[git] no git on this machine; workload.git.* will be skipped'); return null; }
  const base = resolve(cacheDir, 'gitsrv');
  mkdirSync(base, { recursive: true });
  ensureRepo(base);
  const port = await freePort();
  const child = spawn('git', ['daemon', '--export-all', `--base-path=${base}`, '--listen=0.0.0.0', `--port=${port}`, '--reuseaddr', base], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  // Wait until it answers: a native clone of the repo
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const dir = join(base, `probe-${process.pid}`);
      rmSync(dir, { recursive: true, force: true });
      execFileSync('git', ['clone', '-q', `git://127.0.0.1:${port}/${REPO}`, dir], { stdio: 'ignore', timeout: 5000 });
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      if (child.exitCode != null || Date.now() > deadline) { log?.(`[git] git daemon did not start: ${err.slice(-200)}`); child.kill(); return null; }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { port, repo: REPO, close: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); r(); }, 2000).unref(); }) };
}
