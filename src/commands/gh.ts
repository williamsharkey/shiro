import git from 'isomorphic-git';
import { Command, CommandContext } from './index';
import { ghApiHandler } from './gh-api';
import { ghIssueHandler } from './gh-issue';
import { ghPrHandler } from './gh-pr';
import { ghReleaseHandler } from './gh-release';
import { ghWorkflowHandler, ghRunHandler } from './gh-workflow';
import { ghLabelHandler } from './gh-label';
import { ghSearchHandler } from './gh-search';
import { getShiroOrigin } from '../utils/shiro-origin';
import {
  DEFAULT_GITHUB_SCOPES, GITHUB_TOKEN_KEY, ensureGitIdentity, openGitHubLoginPanel,
  pollForToken, requestDeviceCode, saveGitHubToken,
} from '../github-auth';

export function getToken(ctx: CommandContext): string {
  return ctx.env['GITHUB_TOKEN'] || ctx.env['GH_TOKEN']
    || (typeof localStorage !== 'undefined' ? localStorage.getItem('shiro_github_token') || '' : '');
}

export async function detectRepo(ctx: CommandContext): Promise<{ owner: string; repo: string } | null> {
  try {
    const fs = ctx.fs.toIsomorphicGitFS();
    const remotes = await git.listRemotes({ fs, dir: ctx.cwd });
    const origin = remotes.find(r => r.remote === 'origin') || remotes[0];
    if (!origin) return null;
    const m = origin.url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  } catch { return null; }
}

export async function ghApi(
  token: string, method: string, path: string, body?: any, extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: any; headers: Headers }> {
  const baseUrl = `${getShiroOrigin()}/api/github`;
  const url = path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? path : '/' + path}`;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  return { status: resp.status, data, headers: resp.headers };
}

export function parseFlags(args: string[], valueFlags: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const key = a.replace(/^-+/, '');
      if (valueFlags.includes(key) || valueFlags.includes(a)) {
        flags[key] = args[++i] || '';
      } else {
        const eq = a.indexOf('=');
        if (eq > 0) {
          flags[a.slice(2, eq)] = a.slice(eq + 1);
        } else {
          flags[key] = 'true';
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const secs = Math.floor((now - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function getRepoFromFlags(flags: Record<string, string>): { owner: string; repo: string } | null {
  const r = flags['repo'] || flags['R'];
  if (!r) return null;
  const parts = r.split('/');
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

export function isDryRun(flags: Record<string, string>): boolean {
  return flags['dry-run'] === 'true';
}

/** Scopes on a token, from the X-OAuth-Scopes header of any API response. */
function tokenScopes(headers: Headers): string[] {
  return (headers.get('x-oauth-scopes') || '').split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * Device-flow sign-in: print the one-time code like gh does, show the panel,
 * wait for approval, save the token, and fill in git identity if unset.
 */
async function deviceLogin(ctx: CommandContext, scopes: string[]): Promise<number> {
  const say = (s: string) => {
    if (ctx.terminal) ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n'));
    else ctx.stdout += s;
  };
  let code;
  try {
    code = await requestDeviceCode(scopes);
  } catch (e: any) {
    ctx.stderr += `error: could not start GitHub sign-in: ${e?.message || e}\n`;
    return 1;
  }
  say(`! First copy your one-time code: ${code.user_code}\n`);
  say(`Open this URL to continue in your web browser: ${code.verification_uri}\n`);
  // Open the panel even without a terminal: under Claude Code's `!` mode or Bash
  // tool the printed code only shows up after the command finishes, which is too late.
  const panel = typeof window !== 'undefined' && typeof document !== 'undefined' ? openGitHubLoginPanel(code) : null;
  if (panel) say('(A sign-in panel opened with Copy and Open buttons.)\n');
  let token: string;
  try {
    token = await pollForToken(code, {
      signal: panel?.signal,
      onStatus: (st) => panel?.setStatus(st === 'slow_down' ? 'Still waiting…' : 'Waiting for you to approve on GitHub…'),
    });
  } catch (e: any) {
    panel?.setStatus(`Sign-in failed: ${e?.message || e}`, 'err');
    ctx.stderr += `error: GitHub sign-in ${e?.message === 'cancelled' ? 'cancelled' : 'failed: ' + (e?.message || e)}\n`;
    return 1;
  }
  saveGitHubToken(token);
  ctx.env['GITHUB_TOKEN'] = token;
  const { status, data } = await ghApi(token, 'GET', '/user');
  const login = status === 200 ? data.login : 'your account';
  panel?.setStatus(`Signed in as ${login}.`, 'ok');
  setTimeout(() => panel?.close(), 1200);
  say(`✓ Authentication complete.\n✓ Logged in as ${login}\n`);
  try {
    const set = await ensureGitIdentity(ctx.fs, token);
    if (set.name) say(`✓ Set git user.name to "${set.name}"\n`);
    if (set.email) say(`✓ Set git user.email to ${set.email}\n`);
  } catch { /* identity is a convenience */ }
  return 0;
}

function parseScopes(flags: Record<string, string>): string[] {
  const raw = flags['scopes'] ?? flags['s'] ?? '';
  return raw.split(/[\s,]+/).filter(Boolean);
}

export const ghCmd: Command = {
  name: 'gh',
  description: 'GitHub CLI',
  async exec(ctx: CommandContext) {
    const sub = ctx.args[0];

    if (sub === '--version' || sub === '-v') {
      ctx.stdout = 'gh 0.1.0 (shiro)\n';
      return 0;
    }

    if (!sub || sub === '--help' || sub === '-h') {
      ctx.stdout = `usage: gh <command> <subcommand> [flags]

Commands:
  pr        Pull requests (list, create, view, merge, close, comment, diff, checks, review, edit, ready)
  issue     Issues (list, create, view, close, reopen, comment, edit, delete, lock, label)
  release   Releases (list, create, view, download)
  api       Make GitHub API requests
  auth      Authentication (status, login, logout)
  repo      Repository (view, list, create, clone)
  workflow  Workflows (list)
  run       Workflow runs (list, view)
  label     Labels (list, create)
  search    Search (issues, repos)
`;
      return 0;
    }

    const token = getToken(ctx);

    switch (sub) {
      case 'auth': {
        const authSub = ctx.args[1] || 'status';
        if (authSub === 'status') {
          if (!token) {
            ctx.stderr = 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n';
            return 1;
          }
          const { status, data, headers } = await ghApi(token, 'GET', '/user');
          if (status !== 200) {
            ctx.stderr = `error: authentication failed (HTTP ${status})\n`;
            return 1;
          }
          ctx.stdout = `github.com\n  ✓ Logged in to github.com account ${data.login} (${data.name || ''})\n`;
          ctx.stdout += `  - Token: ${token.slice(0, 4)}${'*'.repeat(Math.max(0, token.length - 4))}\n`;
          const scopes = tokenScopes(headers);
          if (scopes.length) ctx.stdout += `  - Token scopes: ${scopes.map((x) => `'${x}'`).join(', ')}\n`;

        } else if (authSub === 'login') {
          const { flags } = parseFlags(ctx.args.slice(2), ['scopes', 's', 'hostname', 'h', 'git-protocol', 'p']);
          if (flags['with-token'] !== 'true') {
            const extra = parseScopes(flags);
            return deviceLogin(ctx, [...new Set([...DEFAULT_GITHUB_SCOPES, ...extra])]);
          }
          if (flags['with-token'] === 'true') {
            const t = (ctx.stdin || '').trim();
            if (!t) {
              ctx.stderr = 'error: pipe a token via stdin: echo ghp_xxx | gh auth login --with-token\n';
              return 1;
            }
            if (typeof localStorage !== 'undefined') localStorage.setItem(GITHUB_TOKEN_KEY, t);
            ctx.env['GITHUB_TOKEN'] = t;
            ctx.stdout = `Logged in. Token saved.\n`;
          } else {
            return 1;
          }
        } else if (authSub === 'refresh') {
          const { flags } = parseFlags(ctx.args.slice(2), ['scopes', 's', 'remove-scopes', 'r', 'hostname', 'h']);
          let current: string[] = [];
          if (token) current = tokenScopes((await ghApi(token, 'GET', '/user')).headers);
          const remove = new Set((flags['remove-scopes'] ?? flags['r'] ?? '').split(/[\s,]+/).filter(Boolean));
          const want = [...new Set([...DEFAULT_GITHUB_SCOPES, ...current, ...parseScopes(flags)])].filter((x) => !remove.has(x));
          return deviceLogin(ctx, want);
        } else if (authSub === 'token') {
          if (!token) { ctx.stderr = 'no oauth token found for github.com\n'; return 1; }
          ctx.stdout = token + '\n';
        } else if (authSub === 'setup-git') {
          // Shiro's git already uses the gh token for github.com remotes
          if (!token) { ctx.stderr = 'You are not logged into any GitHub hosts. Run gh auth login first.\n'; return 1; }
        } else if (authSub === 'logout') {
          if (typeof localStorage !== 'undefined') localStorage.removeItem('shiro_github_token');
          delete ctx.env['GITHUB_TOKEN'];
          delete ctx.env['GH_TOKEN'];
          ctx.stdout = 'Logged out.\n';
        } else {
          ctx.stderr = `gh auth: '${authSub}' is not a valid subcommand. Valid: login, logout, refresh, status, token, setup-git\n`;
          return 1;
        }
        return 0;
      }

      case 'repo': {
        const repoSub = ctx.args[1];
        if (!repoSub || repoSub === '--help') {
          ctx.stdout = 'usage: gh repo <command> [flags]\n\nCommands:\n  view     View a repository [--json fields]\n  list     List repositories [owner]\n  create   Create a repository [owner/]<name> --public|--private [-d desc] [--source dir [--push] [--remote name]] [--clone]\n  clone    Clone a repository <owner/repo> [dir]\n  delete   Delete a repository <owner/repo> --yes\n';
          return 0;
        }
        if (repoSub === 'view') {
          if (!token) {
            ctx.stderr = 'error: not signed in to GitHub. Run: gh auth login\n';
            return 1;
          }
          const { flags, positional } = parseFlags(ctx.args.slice(2), ['repo', 'R', 'json', 'q', 'jq']);
          let repo: { owner: string; repo: string } | null = null;
          if (positional[0]) {
            const parts = positional[0].split('/');
            if (parts.length === 2) repo = { owner: parts[0], repo: parts[1] };
          }
          if (!repo) repo = getRepoFromFlags(flags) || await detectRepo(ctx);
          if (!repo) {
            ctx.stderr = 'error: could not detect repository. Use --repo owner/repo.\n';
            return 1;
          }
          const { status, data } = await ghApi(token, 'GET', `/repos/${repo.owner}/${repo.repo}`);
          if (status !== 200) {
            ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
            return 1;
          }
          if (flags['json'] !== undefined) {
            const all: Record<string, any> = {
              name: data.name,
              nameWithOwner: data.full_name,
              owner: { login: data.owner?.login },
              description: data.description ?? '',
              url: data.html_url,
              sshUrl: data.ssh_url,
              visibility: String(data.visibility || (data.private ? 'private' : 'public')).toUpperCase(),
              isPrivate: !!data.private,
              isFork: !!data.fork,
              defaultBranchRef: { name: data.default_branch },
              stargazerCount: data.stargazers_count,
              createdAt: data.created_at,
              pushedAt: data.pushed_at,
            };
            const fields = flags['json'] && flags['json'] !== 'true' ? flags['json'].split(',') : Object.keys(all);
            const out: Record<string, any> = {};
            for (const f of fields) if (f in all) out[f] = all[f];
            ctx.stdout = JSON.stringify(out, null, 2) + '\n';
            return 0;
          }
          ctx.stdout = `${data.full_name}\n`;
          if (data.description) ctx.stdout += `${data.description}\n`;
          ctx.stdout += `\nStars: ${data.stargazers_count}  Forks: ${data.forks_count}  Open Issues: ${data.open_issues_count}\n`;
          ctx.stdout += `Default branch: ${data.default_branch}\n`;
          ctx.stdout += `Language: ${data.language || 'N/A'}  License: ${data.license?.spdx_id || 'N/A'}\n`;
          ctx.stdout += `\n${data.html_url}\n`;
          return 0;
        }
        if (repoSub === 'list') {
          if (!token) { ctx.stderr = 'error: not signed in to GitHub. Run: gh auth login\n'; return 1; }
          const { flags, positional } = parseFlags(ctx.args.slice(2), ['L', 'limit']);
          const limit = parseInt(flags['L'] || flags['limit'] || '30', 10);
          const owner = positional[0];
          const endpoint = owner ? `/users/${owner}/repos?per_page=${limit}&sort=updated` : `/user/repos?per_page=${limit}&sort=updated`;
          const { status, data } = await ghApi(token, 'GET', endpoint);
          if (status !== 200) {
            ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
            return 1;
          }
          if (!data || data.length === 0) {
            ctx.stdout = 'No repositories found\n';
            return 0;
          }
          for (const r of data) {
            const name = (r.full_name || '').padEnd(35);
            const desc = (r.description || '').slice(0, 45);
            const vis = r.private ? 'private' : 'public';
            ctx.stdout += `${name}  ${vis.padEnd(8)}  ${desc}\n`;
          }
          return 0;
        }
        if (repoSub === 'create') {
          if (!token) { ctx.stderr = 'error: not signed in to GitHub. Run: gh auth login\n'; return 1; }
          const { flags, positional } = parseFlags(ctx.args.slice(2),
            ['description', 'd', 'source', 's', 'remote', 'r', 'homepage', 'h', 'team', 't', 'template', 'p', 'gitignore', 'g', 'license', 'l']);
          const visibility = flags['private'] === 'true' ? 'private' : flags['public'] === 'true' ? 'public' : flags['internal'] === 'true' ? 'internal' : '';
          const source = flags['source'] ?? flags['s'];
          let fullName = positional[0] || '';
          if (!fullName && source) fullName = ctx.fs.resolvePath(source, ctx.cwd).split('/').filter(Boolean).pop() || '';
          if (!fullName) { ctx.stderr = 'error: repository name is required\nusage: gh repo create [owner/]<name> --public|--private [--source dir [--push]]\n'; return 1; }
          if (!visibility) { ctx.stderr = '--public, --private, or --internal required when not running interactively\n'; return 1; }
          const [ownerPart, namePart] = fullName.includes('/') ? fullName.split('/', 2) : ['', fullName];
          const payload: any = { name: namePart, private: visibility !== 'public' };
          if (visibility === 'internal') payload.visibility = 'internal';
          const desc = flags['description'] ?? flags['d'];
          if (desc) payload.description = desc;
          const homepage = flags['homepage'] ?? flags['h'];
          if (homepage) payload.homepage = homepage;
          let endpoint = '/user/repos';
          if (ownerPart) {
            const me = await ghApi(token, 'GET', '/user');
            if (me.data?.login?.toLowerCase() !== ownerPart.toLowerCase()) endpoint = `/orgs/${ownerPart}/repos`;
          }
          const { status, data } = await ghApi(token, 'POST', endpoint, payload);
          if (status !== 201) {
            ctx.stderr = `error: failed to create repository (HTTP ${status}): ${data?.message || ''}${data?.errors ? ' ' + JSON.stringify(data.errors) : ''}\n`;
            return 1;
          }
          ctx.stdout = `✓ Created repository ${data.full_name} on GitHub\n  ${data.html_url}\n`;
          const cloneUrl = data.clone_url as string;
          const run = (cmd: string) => ctx.shell.execute(cmd, (o: string) => { ctx.stdout += o; }, (e: string) => { ctx.stderr += e; });
          const q = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
          if (source) {
            const dir = ctx.fs.resolvePath(source, ctx.cwd);
            const remoteName = flags['remote'] ?? flags['r'] ?? 'origin';
            const code = await run(`cd ${q(dir)} && git remote add ${q(remoteName)} ${q(cloneUrl)}`);
            if (code !== 0) return code;
            ctx.stdout += `✓ Added remote ${cloneUrl}\n`;
            if (flags['push'] === 'true') {
              const pushCode = await run(`cd ${q(dir)} && git push ${q(remoteName)}`);
              if (pushCode !== 0) return pushCode;
              ctx.stdout += `✓ Pushed commits to ${cloneUrl}\n`;
            }
          } else if (flags['clone'] === 'true') {
            return run(`git clone ${q(cloneUrl)}`);
          }
          return 0;
        }
        if (repoSub === 'delete') {
          if (!token) { ctx.stderr = 'error: not signed in to GitHub. Run: gh auth login\n'; return 1; }
          const { flags, positional } = parseFlags(ctx.args.slice(2), []);
          const repo = positional[0]?.includes('/')
            ? { owner: positional[0].split('/')[0], repo: positional[0].split('/')[1] }
            : await detectRepo(ctx);
          if (!repo) { ctx.stderr = 'usage: gh repo delete <owner/repo> --yes\n'; return 1; }
          if (flags['yes'] !== 'true' && flags['confirm'] !== 'true') {
            ctx.stderr = `--yes required to delete ${repo.owner}/${repo.repo} when not running interactively\n`;
            return 1;
          }
          const { status, data } = await ghApi(token, 'DELETE', `/repos/${repo.owner}/${repo.repo}`);
          if (status !== 204) {
            const hint = status === 403 ? ' (the token needs the delete_repo scope)' : '';
            ctx.stderr = `error: failed to delete repository (HTTP ${status}): ${data?.message || ''}${hint}\n`;
            return 1;
          }
          ctx.stdout = `✓ Deleted repository ${repo.owner}/${repo.repo}\n`;
          return 0;
        }
        if (repoSub === 'clone') {
          const target = ctx.args[2];
          if (!target) { ctx.stderr = 'usage: gh repo clone <owner/repo> [directory]\n'; return 1; }
          const cloneUrl = target.includes('/') ? `https://github.com/${target}.git` : target;
          const destDir = ctx.args[3] || '';
          const cloneCmd = destDir ? `git clone ${cloneUrl} ${destDir}` : `git clone ${cloneUrl}`;
          return ctx.shell.execute(cloneCmd, (s: string) => { ctx.stdout += s; }, (s: string) => { ctx.stderr += s; });
        }
        ctx.stderr = `gh repo: '${repoSub}' is not a valid subcommand. Valid: view, list, create, clone, delete\n`;
        return 1;
      }

      case 'pr':
        return ghPrHandler(ctx, token);

      case 'issue':
        return ghIssueHandler(ctx, token);

      case 'release':
        return ghReleaseHandler(ctx, token);

      case 'api':
        return ghApiHandler(ctx, token);

      case 'workflow':
        return ghWorkflowHandler(ctx, token);

      case 'run':
        return ghRunHandler(ctx, token);

      case 'label':
        return ghLabelHandler(ctx, token);

      case 'search':
        return ghSearchHandler(ctx, token);

      default:
        ctx.stderr = `gh: '${sub}' is not a valid command. See 'gh --help'.\n`;
        return 1;
    }
  },
};
