/**
 * tmux without a terminal (williamsharkey/tabcomputer#14): what agents and
 * scripts run to keep a server going and read its output.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;

beforeAll(async () => {
  ({ shell } = await createTestShell());
  const { tmuxCmd } = await import('@shiro/commands/tmux');
  shell.commands.register(tmuxCmd);
});

afterEach(async () => { await sh('tmux kill-server'); });

async function sh(cmd: string) {
  let out = '';
  let err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

/** Poll until `check` holds (pane output arrives in the background) */
async function until(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const capture = async (t: string) => (await sh(`tmux capture-pane -p -t ${t}`)).out;

describe('tmux, detached', () => {
  it('new-session -d runs its command; the session ends with it', async () => {
    const r = await sh('tmux new-session -d -s srv "echo started; sleep 0.3; echo done"');
    expect(r.code).toBe(0);
    expect((await sh('tmux has-session -t srv')).code).toBe(0);
    expect((await sh('tmux ls')).out).toContain('srv: 1 windows');
    await until(async () => (await capture('srv')).includes('started'));
    await until(async () => (await sh('tmux has-session -t srv')).code === 1);
    expect((await sh('tmux has-session -t srv')).err).toContain("can't find session: srv");
  });

  it('send-keys types lines into a pane shell; capture-pane -p prints the screen', async () => {
    await sh('tmux new -d -s w');
    await sh('tmux send-keys -t w "echo hi $((1+2))" Enter');
    await until(async () => /^hi 3$/m.test(await capture('w')));
    // C-c ends what the pane runs; the shell goes on
    await sh('tmux send-keys -t w "sleep 30" C-m');
    await sh('tmux send-keys -t w C-c');
    await sh('tmux send-keys -t w "echo after" Enter');
    await until(async () => /^after$/m.test(await capture('w:0.0')));
  });

  it('a pane keeps its own cwd and says it is in tmux', async () => {
    await sh('mkdir -p /tmp/tmuxdir');
    await sh('tmux new -d -s c -c /tmp/tmuxdir');
    await sh("tmux send-keys -t c 'pwd; echo pane=$TMUX_PANE' Enter");
    await until(async () => /^\/tmp\/tmuxdir$/m.test(await capture('c')));
    expect(await capture('c')).toMatch(/^pane=%\d+$/m);
  });

  it('kill-session ends the pane and duplicates are refused', async () => {
    await sh('tmux new -d -s k "sleep 30"');
    expect((await sh('tmux new -d -s k')).err).toContain('duplicate session: k');
    expect((await sh('tmux kill-session -t k')).code).toBe(0);
    expect((await sh('tmux has -t k')).code).toBe(1);
  });

  it('display -p and list-panes -F expand formats', async () => {
    await sh('tmux new -d -s f');
    const r = await sh('tmux display -p -t f "#{session_name} #{pane_id}"');
    expect(r.out).toMatch(/^f %\d+\n$/);
    expect((await sh('tmux list-panes -t f -F "#{pane_dead} #{pane_width}x#{pane_height}"')).out).toBe('0 80x24\n');
  });

  it('attaching still needs a terminal', async () => {
    const r = await sh('tmux new -s x');
    expect(r.code).toBe(1);
    expect(r.err).toContain('not a terminal');
  });
});
