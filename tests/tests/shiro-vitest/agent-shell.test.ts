/**
 * What agent CLIs do with the shell, as native Claude Code does it: a kernel
 * `sh -c -l` whose stdin is a pipe that stays open, sourcing Claude Code's
 * shell snapshot (fixtures/claude-snapshot) before each command; [[ … ]] in
 * if/elif/while; exec -a; which with several names; timeout, kill and
 * Ctrl-C ending a builtin that never returns.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { Kernel } from '@shiro/kernel/kernel';
import { Process } from '@shiro/kernel/process';
import { createPipe } from '@shiro/kernel/pipe';
import { SinkFile } from '@shiro/wasi/stdio';
import { kernelForContext } from '@shiro/wasi/run-command';
import type { CommandContext } from '@shiro/commands/index';

const SNAPSHOT = readFileSync(path.join(__dirname, 'fixtures/claude-snapshot/snapshot-bash.sh'), 'utf8');
const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
/** Claude Code's command line for its Bash tool (from the native binary) */
const claudeWrap = (cmd: string) =>
  `source /home/user/.claude/shell-snapshots/snapshot-bash.sh 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval ${sq(cmd)} < /dev/null && pwd -P >| /tmp/claude-cwd`;

// A native ELF that prints its argv (the claude binary's multicall stand-in)
const stubDir = mkdtempSync(path.join(tmpdir(), 'shiro-printargv-'));
const stub = path.join(stubDir, 'printargv');
let haveGcc = false;
try { execFileSync('gcc', ['-static', '-O1', '-o', stub, 'printargv.c'], { cwd: path.join(__dirname, 'fixtures/x86'), stdio: 'pipe', timeout: 120_000 }); haveGcc = true; } catch { /* no compiler */ }

let fs: FileSystem;
let shell: Shell;
let kernel: Kernel;

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
  await fs.mkdir('/home/user/.claude/shell-snapshots', { recursive: true });
  await fs.writeFile('/home/user/.claude/shell-snapshots/snapshot-bash.sh', SNAPSHOT);
  await fs.writeFile('/tmp/f.txt', ' 1 one\n2 two\n 3 three\n');
  shell.commands.register({ name: 'hang', description: 'a builtin that never returns', exec: () => new Promise<number>(() => {}) });
});

/** `sh -c -l CMD` as a kernel process with a stdin pipe that stays open (an agent's spawn) */
async function agentSh(cmd: string, env: Record<string, string> = {}, ms = 15_000): Promise<{ out: string; status: number | 'hung'; proc: Process }> {
  const e = { ...shell.env, PATH: '/usr/local/bin:/usr/bin:/bin', ...env };
  const argv = ['/bin/sh', '-c', '-l', cmd];
  const run = await kernel.findProgram('/bin/sh', new Process({ pid: -1, ppid: 1, path: '/bin/sh', argv, env: e, cwd: '/home/user' }));
  const [rd, wr] = createPipe();
  let out = '';
  const proc = kernel.spawn({ path: '/bin/sh', argv, env: e, cwd: '/home/user', fds: { 0: rd, 1: new SinkFile((t) => { out += t; }), 2: new SinkFile((t) => { out += t; }) }, run: run! });
  const status = await Promise.race([proc.wait(), new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);
  void wr.close();
  return { out, status, proc };
}

describe("Claude Code's shell snapshot", () => {
  it('without the native binary: grep and find fall back to the real ones', async () => {
    let r = await agentSh(claudeWrap("grep -E '^ *(1|2) ' /tmp/f.txt"));
    expect(r).toMatchObject({ out: ' 1 one\n2 two\n', status: 0 });
    r = await agentSh(claudeWrap('find /tmp -name f.txt'));
    expect(r).toMatchObject({ out: '/tmp/f.txt\n', status: 0 });
    r = await agentSh(claudeWrap('type pkill | head -1; type grep | head -1; cat /tmp/claude-cwd'));
    expect(r).toMatchObject({ out: 'pkill is a function\ngrep is a function\n/home/user\n', status: 0 });
  });

  it.skipIf(!haveGcc)('with it: (exec -a ugrep "$_cc_bin" …) runs the binary as ugrep / bfs, arguments intact', async () => {
    await fs.mkdir('/home/user/.local/bin', { recursive: true });
    await fs.writeFile('/home/user/.local/bin/claude', new Uint8Array(readFileSync(stub)), { mode: 0o755 });
    try {
      for (const env of [{}, { CLAUDE_CODE_EXECPATH: '/home/user/.local/bin/claude' }]) {
        let r = await agentSh(claudeWrap("grep -E '^ *(1|2) ' /tmp/f.txt"), env);
        expect(r.status).toBe(0);
        expect(r.out).toBe('argv0=ugrep [-G] [--ignore-files] [--hidden] [-I] [--exclude-dir=.git] [--exclude-dir=.svn] [--exclude-dir=.hg] [--exclude-dir=.bzr] [--exclude-dir=.jj] [--exclude-dir=.sl] [-E] [^ *(1|2) ] [/tmp/f.txt]\n');
        r = await agentSh(claudeWrap('find . -name "*.txt"'), env);
        expect(r.out).toBe('argv0=bfs [-S] [dfs] [-regextype] [findutils-default] [.] [-name] [*.txt]\n');
        // options the wrapper hands to the real grep
        r = await agentSh(claudeWrap('grep -Z x /tmp/f.txt; echo "rc=$?"'), env);
        expect(r.out).toBe('rc=1\n');
      }
    } finally {
      await fs.unlink('/home/user/.local/bin/claude');
    }
  }, 60_000);
});

describe('[[ … ]] wherever it appears', () => {
  const cases: [string, string][] = [
    ['if [[ -n ${EMPTY:-} ]]; then echo yes; else echo no; fi', 'no'],
    ['if [[ -n $EMPTY ]]; then echo yes; elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then echo win; else echo other; fi', 'other'],
    ['while [[ -n ${EMPTY:-} ]]; do echo loop; break; done; echo done', 'done'],
    ['until [[ -z ${EMPTY:-} ]]; do echo loop; break; done; echo done', 'done'],
    ['v=; [[ -x $v ]] || v=/tmp; [[ -d $v ]] && echo "$v"', '/tmp'],
    ['[[ a == a && ( b == c || ! -z x ) ]] && echo and-or-not', 'and-or-not'],
    ['x=ab12; [[ $x =~ ^(ab|cd)[0-9]+$ ]] && echo "${BASH_REMATCH[1]}"', 'ab'],
    ['x="a b"; [[ $x =~ a\\ b ]] && echo spaced', 'spaced'],
    ['[[ -a /tmp/f.txt && -e /tmp/f.txt ]] && echo file-tests', 'file-tests'],
    ['[[ abc == a* ]] && [[ abc != "a*" ]] && echo patterns', 'patterns'],
    ['[[\n  -e /tmp/f.txt &&\n  -n x\n]] && echo multiline', 'multiline'],
    ['f() {\n  if [[ -n ${ZSH_VERSION:-} ]]; then\n    echo zsh\n  else\n    echo bash\n  fi\n}\nf', 'bash'],
  ];
  it.each(cases)('%s', async (cmd, want) => {
    let out = '';
    await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n').trim()).toBe(want);
  });
});

describe('exec -a', () => {
  it.skipIf(!haveGcc)('sets argv[0] of the program it runs; -l prefixes it with -', async () => {
    await fs.writeFile('/tmp/argv0', new Uint8Array(readFileSync(stub)), { mode: 0o755 });
    let r = await agentSh('(exec -a renamed /tmp/argv0 one "two words")');
    expect(r.out).toBe('argv0=renamed [one] [two words]\n');
    r = await agentSh('(exec -l -a name /tmp/argv0)');
    expect(r.out).toBe('argv0=-name\n');
    r = await agentSh('/tmp/argv0 plain');
    expect(r.out).toBe('argv0=/tmp/argv0 [plain]\n');
  }, 60_000);
});

describe('eval with a stdin redirect', () => {
  it("the wrapper's eval … < /dev/null is EOF for cat, not the open pipe", async () => {
    const r = await agentSh(claudeWrap('cat; echo "rc=$?"'), {}, 5000);
    expect(r).toMatchObject({ out: 'rc=0\n', status: 0 });
  });

  it("eval … < file reads the file; a function's redirect still works", async () => {
    const r = await agentSh("eval 'head -1' < /tmp/f.txt; f() { cat; }; f < /dev/null; echo \"rc=$?\"", {}, 5000);
    expect(r).toMatchObject({ out: ' 1 one\nrc=0\n', status: 0 });
  });
});

describe('which, timeout, kill and Ctrl-C', () => {
  it('which prints a line per name found and exits 1 if any is missing', async () => {
    const r = await agentSh('which ls nonesuch-cmd cat 2>&1; echo "rc=$?"');
    // (builtins without a PATH file print where they count as installed)
    expect(r.out.split('\n').filter(Boolean).sort()).toEqual(['/usr/bin/cat', '/usr/bin/ls', 'nonesuch-cmd not found', 'rc=1']);
    expect(r.status).toBe(0);
  });

  it('timeout ends a builtin (sleep, one that never returns) in an agent\'s sh; the shell goes on', async () => {
    const t0 = Date.now();
    let r = await agentSh('timeout 1 sleep 30; echo "rc=$?"; timeout 1 hang; echo "rc=$?"');
    expect(r).toMatchObject({ out: 'rc=124\nrc=124\n', status: 0 });
    expect(Date.now() - t0).toBeLessThan(6000);
    r = await agentSh('timeout 5 echo fast; echo "rc=$?"');
    expect(r.out).toBe('fast\nrc=0\n');
  });

  it('node -v and node --help answer at once though stdin is a pipe that stays open (tabcomputer#13)', async () => {
    const r = await agentSh('timeout 10 node -v; echo "rc=$?"; node --help | head -1; node -v & wait; echo done');
    expect(r).toMatchObject({ out: 'v22.12.0\nrc=0\nUsage: node [options] [script.js] [arguments]\nv22.12.0\ndone\n', status: 0 });
  });

  it('kill ends a shell process running a builtin that never returns', async () => {
    const e = { ...shell.env };
    const argv = ['sh', '-c', 'hang'];
    const run = await kernel.findProgram('sh', new Process({ pid: -1, ppid: 1, path: 'sh', argv, env: e, cwd: '/tmp' }));
    const [rd, wr] = createPipe();
    const p = kernel.spawn({ path: 'sh', argv, env: e, cwd: '/tmp', fds: { 0: rd, 1: new SinkFile(() => {}), 2: new SinkFile(() => {}) }, run: run! });
    await new Promise((r) => setTimeout(r, 200));
    kernel.kill(p.pid, 15);
    const st = await Promise.race([p.wait(), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
    void wr.close();
    expect(st).not.toBe('hung');
  });

  it('Ctrl-C (the shell\'s abort) ends a foreground builtin that never returns', async () => {
    const { shell: page } = await createTestShell();
    page.commands.register({ name: 'hang', description: '', exec: () => new Promise<number>(() => {}) });
    let out = '';
    const r = page.execute('hang; echo after', (s) => { out += s; }, (s) => { out += s; });
    await new Promise((res) => setTimeout(res, 100));
    page.abortController?.abort();
    expect(await Promise.race([r, new Promise((res) => setTimeout(() => res('hung'), 3000))])).toBe(130);
    expect(out).not.toContain('after');
  });
});
