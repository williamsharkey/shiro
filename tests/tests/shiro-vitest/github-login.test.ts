import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createTestShell, run } from './helpers';
import {
  requestDeviceCode, pollForToken, ensureGitIdentity, GITHUB_OAUTH_CLIENT_ID,
  type DeviceCode,
} from '@shiro/github-auth';

const code: DeviceCode = { device_code: 'dev123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };

/** fetch stub that answers each call with the next queued JSON body. */
function queuedFetch(bodies: any[], calls: { url: string; body: any }[] = []) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = bodies.shift();
    return new Response(JSON.stringify(next ?? {}), { status: next?.__status || 200 });
  }) as unknown as typeof fetch;
}
const noSleep = async () => {};

describe('GitHub device sign-in', () => {
  it('requests a code through the github-login proxy with the app client id', async () => {
    const calls: any[] = [];
    const got = await requestDeviceCode(['repo', 'gist'], queuedFetch([code], calls));
    expect(got.user_code).toBe('ABCD-1234');
    expect(calls[0].url).toMatch(/\/api\/github-login\/login\/device\/code$/);
    expect(calls[0].body).toEqual({ client_id: GITHUB_OAUTH_CLIENT_ID, scope: 'repo gist' });
  });

  it('explains when device flow is not enabled for the app', async () => {
    await expect(requestDeviceCode(['repo'], queuedFetch([{ error: 'device_flow_disabled' }])))
      .rejects.toThrow(/device flow is not enabled/);
  });

  it('polls through pending and slow_down until the token arrives', async () => {
    const statuses: string[] = [];
    const calls: any[] = [];
    const token = await pollForToken(code, {
      fetchImpl: queuedFetch([{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'gho_abc' }], calls),
      sleep: noSleep,
      onStatus: (s) => statuses.push(s),
    });
    expect(token).toBe('gho_abc');
    expect(statuses).toEqual(['waiting', 'slow_down']);
    expect(calls[0].body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });

  it('reports expiry and denial', async () => {
    await expect(pollForToken(code, { fetchImpl: queuedFetch([{ error: 'expired_token' }]), sleep: noSleep })).rejects.toThrow(/expired/);
    await expect(pollForToken(code, { fetchImpl: queuedFetch([{ error: 'access_denied' }]), sleep: noSleep })).rejects.toThrow(/denied/);
  });

  it('stops when cancelled', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(pollForToken(code, { signal: ac.signal, fetchImpl: queuedFetch([]), sleep: noSleep })).rejects.toThrow(/cancelled/);
  });
});

describe('git identity from GitHub', () => {
  it('fills in missing name and primary email, and leaves set values alone', async () => {
    const { fs } = await createTestShell();
    try { await fs.unlink('/home/user/.gitconfig'); } catch {}
    const f = queuedFetch([{ login: 'octo', id: 7, name: 'Octo Cat' }, [{ email: 'x@y', primary: false, verified: true }, { email: 'octo@example.com', primary: true, verified: true }]]);
    expect(await ensureGitIdentity(fs, 'tok', f)).toEqual({ name: 'Octo Cat', email: 'octo@example.com' });
    expect(await fs.readFile('/home/user/.gitconfig', 'utf8')).toContain('email = octo@example.com');
    expect(await ensureGitIdentity(fs, 'tok', queuedFetch([]))).toEqual({});
  });

  it('falls back to the noreply address when no verified primary email is visible', async () => {
    const { fs } = await createTestShell();
    await fs.writeFile('/home/user/.gitconfig', '[user]\n\tname = Keep Me\n');
    const f = queuedFetch([{ login: 'octo', id: 7, name: 'Octo Cat' }, { __status: 404, message: 'Not Found' }]);
    expect(await ensureGitIdentity(fs, 'tok', f)).toEqual({ email: '7+octo@users.noreply.github.com' });
    expect(await fs.readFile('/home/user/.gitconfig', 'utf8')).toContain('name = Keep Me');
  });
});

describe('Claude-style shell spawns', () => {
  it('does not run a stray -l when options follow -c', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/dashl', { recursive: true });
    await fs.writeFile('/tmp/dashl/run.mjs', `
      import { spawn } from 'child_process';
      const c = spawn('/bin/zsh', ['-c', '-l', 'echo from-zsh'], { cwd: '/tmp/dashl', stdio: 'pipe' });
      let out = '', err = '';
      c.stdout.on('data', (d) => out += d); c.stderr.on('data', (d) => err += d);
      await new Promise((r) => c.on('close', r));
      console.log('OUT=' + out.trim() + ' ERR=' + err.trim());
    `);
    const { output } = await run(shell, 'node /tmp/dashl/run.mjs');
    expect(output).toContain('OUT=from-zsh');
    expect(output).not.toContain('command not found: -l');
  }, 30000);
});

describe('github-login proxy route', () => {
  let server: ChildProcess;
  const port = 3900 + Math.floor(Math.random() * 90);
  afterAll(() => server?.kill());

  it('only forwards POSTs to the two device-flow endpoints', async () => {
    const serverPath = decodeURIComponent(new URL('../../../server.mjs', import.meta.url).pathname);
    server = spawn('node', [serverPath], { env: { ...process.env, PORT: String(port), STATIC_DIR: '/nonexistent' } });
    await new Promise<void>((resolve) => server.stdout!.on('data', (d) => { if (String(d).includes('listening')) resolve(); }));
    const base = `http://127.0.0.1:${port}/api/github-login`;
    expect((await fetch(`${base}/login/device/code`)).status).toBe(403);           // wrong method
    expect((await fetch(`${base}/settings/profile`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${base}/login/oauth/authorize`, { method: 'POST' })).status).toBe(403);
  }, 20000);
});
