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
            ctx.stderr = 'You are not logged in. Set GITHUB_TOKEN or run: gh auth login --with-token\n';
            return 1;
          }
          const { status, data } = await ghApi(token, 'GET', '/user');
          if (status !== 200) {
            ctx.stderr = `error: authentication failed (HTTP ${status})\n`;
            return 1;
          }
          ctx.stdout = `Logged in to github.com as ${data.login} (${data.name || ''})\n`;
          ctx.stdout += `Token: ${token.slice(0, 8)}...${token.slice(-4)}\n`;
        } else if (authSub === 'login') {
          const { flags } = parseFlags(ctx.args.slice(2), []);
          if (flags['with-token'] === 'true') {
            const t = (ctx.stdin || '').trim();
            if (!t) {
              ctx.stderr = 'error: pipe a token via stdin: echo ghp_xxx | gh auth login --with-token\n';
              return 1;
            }
            if (typeof localStorage !== 'undefined') localStorage.setItem('shiro_github_token', t);
            ctx.env['GITHUB_TOKEN'] = t;
            ctx.stdout = `Logged in. Token saved.\n`;
          } else {
            ctx.stderr = 'usage: echo <token> | gh auth login --with-token\n';
            return 1;
          }
        } else if (authSub === 'logout') {
          if (typeof localStorage !== 'undefined') localStorage.removeItem('shiro_github_token');
          delete ctx.env['GITHUB_TOKEN'];
          delete ctx.env['GH_TOKEN'];
          ctx.stdout = 'Logged out.\n';
        } else {
          ctx.stderr = `gh auth: '${authSub}' is not a valid subcommand. Valid: status, login, logout\n`;
          return 1;
        }
        return 0;
      }

      case 'repo': {
        const repoSub = ctx.args[1];
        if (!repoSub || repoSub === '--help') {
          ctx.stdout = 'usage: gh repo <command> [flags]\n\nCommands:\n  view     View a repository\n  list     List repositories [owner]\n  create   Create a repository <name> [--public|--private]\n  clone    Clone a repository <owner/repo>\n';
          return 0;
        }
        if (repoSub === 'view') {
          if (!token) {
            ctx.stderr = 'error: authentication required. Set GITHUB_TOKEN.\n';
            return 1;
          }
          const { flags, positional } = parseFlags(ctx.args.slice(2), ['repo', 'R']);
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
          ctx.stdout = `${data.full_name}\n`;
          if (data.description) ctx.stdout += `${data.description}\n`;
          ctx.stdout += `\nStars: ${data.stargazers_count}  Forks: ${data.forks_count}  Open Issues: ${data.open_issues_count}\n`;
          ctx.stdout += `Default branch: ${data.default_branch}\n`;
          ctx.stdout += `Language: ${data.language || 'N/A'}  License: ${data.license?.spdx_id || 'N/A'}\n`;
          ctx.stdout += `\n${data.html_url}\n`;
          return 0;
        }
        if (repoSub === 'list') {
          if (!token) { ctx.stderr = 'error: authentication required. Set GITHUB_TOKEN.\n'; return 1; }
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
          if (!token) { ctx.stderr = 'error: authentication required. Set GITHUB_TOKEN.\n'; return 1; }
          const { flags, positional } = parseFlags(ctx.args.slice(2), ['description']);
          const name = positional[0];
          if (!name) { ctx.stderr = 'error: repository name is required\nusage: gh repo create <name> [--public|--private]\n'; return 1; }
          const isPrivate = flags['private'] === 'true';
          const payload: any = { name, private: isPrivate };
          if (flags['description']) payload.description = flags['description'];
          const { status, data } = await ghApi(token, 'POST', '/user/repos', payload);
          if (status === 201) {
            ctx.stdout = `Created repository ${data.full_name}\n${data.html_url}\n`;
          } else {
            ctx.stderr = `error: failed to create repository (HTTP ${status}): ${data?.message || ''}\n`;
            return 1;
          }
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
        ctx.stderr = `gh repo: '${repoSub}' is not a valid subcommand. Valid: view, list, create, clone\n`;
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
