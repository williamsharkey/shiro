/**
 * The built-in gh's flags (williamsharkey/tabcomputer#11): --body-file
 * and -F (with - for stdin) set the body, --json uses gh's field names and
 * --jq/-q filters it, and a flag a subcommand doesn't implement is an
 * error instead of being dropped. GitHub's API is a stub here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestShell } from './helpers';
import { ghCmd } from '@shiro/commands/gh';

interface Call { method: string; path: string; body: any }
let calls: Call[];
const ISSUE = {
  number: 12, title: 'A title', body: 'the body', state: 'open', html_url: 'https://github.com/o/r/issues/12',
  user: { login: 'ann' }, labels: [{ name: 'bug', color: 'f00', description: '', node_id: 'L1' }], assignees: [],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', closed_at: null, node_id: 'I_12', comments: 3,
};

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^.*\/api\/github/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', path, body });
    const json = (status: number, data: any) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/repos/o/r/issues' && init.method === 'POST') return json(201, { ...ISSUE, number: 13, title: body.title, body: body.body });
    if (path.startsWith('/repos/o/r/issues?')) return json(200, [ISSUE]);
    if (path === '/repos/o/r/issues/12') return json(200, ISSUE);
    if (path === '/repos/o/r/pulls' && init.method === 'POST') return json(201, { number: 5, html_url: 'https://github.com/o/r/pull/5', title: body.title });
    if (path.startsWith('/repos/o/r/labels')) return json(200, [{ name: 'bug', color: 'f00', description: 'x', node_id: 'L1', default: true }]);
    return json(404, { message: 'Not Found' });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function gh(cmd: string) {
  const { shell, fs } = await createTestShell();
  shell.commands.register(ghCmd);
  await fs.writeFile('/tmp/b.md', 'hello body\nline 2\n');
  let out = '', err = '';
  const code = await shell.execute(`cd /tmp && GITHUB_TOKEN=t ${cmd}`, (s) => { out += s; }, (s) => { err += s; });
  return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
}

describe('gh: bodies from files', () => {
  it('issue create --body-file, -F, --body-file - (stdin)', async () => {
    for (const [cmd, body] of [
      ['gh issue create -R o/r --title t --body-file b.md', 'hello body\nline 2\n'],
      ['gh issue create -R o/r -t t -F b.md', 'hello body\nline 2\n'],
      ["printf 'from stdin' | gh issue create --repo=o/r --title=t --body-file -", 'from stdin'],
    ] as const) {
      calls = [];
      const r = await gh(cmd);
      expect(r.code, cmd).toBe(0);
      expect(r.out).toContain('Created issue #13');
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ title: 't', body });
    }
    calls = [];
    const missing = await gh('gh issue create -R o/r -t t --body-file nope.md');
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('open nope.md: no such file or directory');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('issue comment / edit and pr create take --body-file too; pr create -B -H -d', async () => {
    await gh('gh issue edit 12 -R o/r --body-file b.md');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ body: 'hello body\nline 2\n' });
    calls = [];
    await gh('gh issue comment 12 -R o/r -F b.md');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ body: 'hello body\nline 2\n' });
    calls = [];
    const r = await gh('gh pr create -R o/r -t T -F b.md -B dev -H feat -d');
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ title: 'T', body: 'hello body\nline 2\n', base: 'dev', head: 'feat', draft: true });
  });
});

describe('gh: --json with gh field names, --jq / -q', () => {
  it('issue view --json body -q .body prints the body', async () => {
    const r = await gh('gh issue view 12 -R o/r --json body -q .body');
    expect([r.code, r.out]).toEqual([0, 'the body\n']);
  });

  it('fields as gh names them; lists; unknown fields list the available ones', async () => {
    const v = await gh('gh issue view 12 -R o/r --json number,title,state,author,url,labels,createdAt');
    expect(JSON.parse(v.out)).toEqual({
      number: 12, title: 'A title', state: 'OPEN', author: { login: 'ann' }, url: 'https://github.com/o/r/issues/12',
      labels: [{ id: 'L1', name: 'bug', description: '', color: 'f00' }], createdAt: '2026-01-01T00:00:00Z',
    });
    expect((await gh("gh issue list -R o/r --json number,title --jq '.[] | \"\\(.number) \\(.title)\"'")).out).toBe('12 A title\n');
    expect((await gh("gh label list -R o/r --json name,isDefault -q '.[0]'")).out).toBe('{"name":"bug","isDefault":true}\n');
    const bad = await gh('gh issue view 12 -R o/r --json bodyText');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('Unknown JSON field: "bodyText"');
    expect(bad.err).toContain('  createdAt');
    const noJson = await gh('gh issue view 12 -R o/r -q .body');
    expect(noJson.code).toBe(1);
    expect(noJson.err).toContain('cannot use `--jq` without specifying `--json`');
  });
});

describe('gh: flags a subcommand lacks are errors', () => {
  it('unknown long and short flags, a missing value, --template', async () => {
    for (const [cmd, msg] of [
      ['gh issue create -R o/r -t x --web', 'unknown flag: --web'],
      ['gh pr list -R o/r --author me', 'unknown flag: --author'],
      ['gh issue view 12 -R o/r -z', "unknown shorthand flag: 'z' in -z"],
      ['gh issue create -R o/r --title', 'flag needs an argument: --title'],
      ['gh issue view 12 -R o/r --json title --template "{{.title}}"', '--template is not supported'],
      ['gh api repos/o/r --input f.json', 'unknown flag: --input'],
    ] as const) {
      const r = await gh(cmd);
      expect(r.code, cmd).toBe(1);
      expect(r.err, cmd).toContain(msg);
    }
    expect(calls).toEqual([]); // nothing was sent
  });
});
