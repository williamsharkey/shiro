import git from 'isomorphic-git';
import { Command, CommandContext } from './index';

function getToken(ctx: CommandContext): string {
  return ctx.env['GITHUB_TOKEN'] || ctx.env['GH_TOKEN']
    || (typeof localStorage !== 'undefined' ? localStorage.getItem('shiro_github_token') || '' : '');
}

async function detectRepo(ctx: CommandContext): Promise<{ owner: string; repo: string } | null> {
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

async function ghApi(token: string, method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  const baseUrl = typeof location !== 'undefined' ? location.origin + '/api/github' : 'https://api.github.com';
  const url = path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? path : '/' + path}`;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  return { status: resp.status, data };
}

function parseFlags(args: string[], valueFlags: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const key = a.replace(/^-+/, '');
      if (valueFlags.includes(key) || valueFlags.includes(a)) {
        flags[key] = args[++i] || '';
      } else {
        // Boolean flag or flag=value
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

function timeAgo(dateStr: string): string {
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

function getRepoFromFlags(flags: Record<string, string>): { owner: string; repo: string } | null {
  const r = flags['repo'] || flags['R'];
  if (!r) return null;
  const parts = r.split('/');
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

export const ghCmd: Command = {
  name: 'gh',
  description: 'GitHub CLI',
  async exec(ctx: CommandContext) {
    const sub = ctx.args[0];
    if (!sub || sub === '--help' || sub === '-h') {
      ctx.stdout = `usage: gh <command> <subcommand> [flags]

Commands:
  pr       Pull requests (list, create, view, merge)
  issue    Issues (list, create, view)
  api      Make GitHub API requests
  auth     Authentication status
`;
      return 0;
    }

    const token = getToken(ctx);

    switch (sub) {
      case 'auth': {
        const authSub = ctx.args[1] || 'status';
        if (authSub === 'status') {
          if (!token) {
            ctx.stderr = 'You are not logged in. Set GITHUB_TOKEN or run: export GITHUB_TOKEN=ghp_...\n';
            return 1;
          }
          const { status, data } = await ghApi(token, 'GET', '/user');
          if (status !== 200) {
            ctx.stderr = `error: authentication failed (HTTP ${status})\n`;
            return 1;
          }
          ctx.stdout = `Logged in to github.com as ${data.login} (${data.name || ''})\n`;
          ctx.stdout += `Token: ${token.slice(0, 8)}...${token.slice(-4)}\n`;
        } else {
          ctx.stderr = `gh auth: '${authSub}' is not a valid subcommand\n`;
          return 1;
        }
        break;
      }

      case 'pr': {
        const prSub = ctx.args[1];
        if (!prSub || prSub === '--help') {
          ctx.stdout = `usage: gh pr <command> [flags]

Commands:
  list     List pull requests
  create   Create a pull request
  view     View a pull request
  merge    Merge a pull request
`;
          return 0;
        }

        if (!token) {
          ctx.stderr = 'error: authentication required. Set GITHUB_TOKEN.\n';
          return 1;
        }

        const { flags, positional } = parseFlags(ctx.args.slice(2), ['state', 'L', 'limit', 'title', 'body', 'base', 'head', 'repo', 'R', 'merge', 'squash', 'rebase']);
        const repo = getRepoFromFlags(flags) || await detectRepo(ctx);
        if (!repo) {
          ctx.stderr = 'error: could not detect repository. Use --repo owner/repo or run from a git repo with a GitHub remote.\n';
          return 1;
        }

        switch (prSub) {
          case 'list': {
            const state = flags['state'] || 'open';
            const limit = parseInt(flags['L'] || flags['limit'] || '30', 10);
            const { status, data } = await ghApi(token, 'GET', `/repos/${repo.owner}/${repo.repo}/pulls?state=${state}&per_page=${limit}`);
            if (status !== 200) {
              ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
              return 1;
            }
            if (!data || data.length === 0) {
              ctx.stdout = 'No pull requests match your search\n';
              break;
            }
            for (const pr of data) {
              const num = `#${pr.number}`.padEnd(6);
              const title = pr.title.slice(0, 50).padEnd(50);
              const branch = `${pr.head?.ref || '?'} -> ${pr.base?.ref || '?'}`;
              const state = pr.state.toUpperCase().padEnd(8);
              const age = timeAgo(pr.created_at);
              ctx.stdout += `${num}  ${title}  ${branch.padEnd(30)}  ${state}  ${age}\n`;
            }
            break;
          }

          case 'create': {
            const title = flags['title'] || flags['t'];
            const body = flags['body'] || flags['b'] || '';
            const base = flags['base'] || 'main';
            let head = flags['head'] || '';
            if (!title) {
              ctx.stderr = 'error: --title is required\n';
              return 1;
            }
            if (!head) {
              try {
                const fs = ctx.fs.toIsomorphicGitFS();
                head = await git.currentBranch({ fs, dir: ctx.cwd }) || '';
              } catch {}
            }
            if (!head) {
              ctx.stderr = 'error: could not detect current branch. Use --head <branch>\n';
              return 1;
            }
            const { status, data } = await ghApi(token, 'POST', `/repos/${repo.owner}/${repo.repo}/pulls`, {
              title, body, head, base,
            });
            if (status === 201) {
              ctx.stdout = `Created PR #${data.number}: ${data.title}\n${data.html_url}\n`;
            } else {
              ctx.stderr = `error: failed to create PR (HTTP ${status}): ${data?.message || JSON.stringify(data?.errors)}\n`;
              return 1;
            }
            break;
          }

          case 'view': {
            const num = positional[0];
            if (!num) {
              ctx.stderr = 'usage: gh pr view <number>\n';
              return 1;
            }
            const { status, data } = await ghApi(token, 'GET', `/repos/${repo.owner}/${repo.repo}/pulls/${num}`);
            if (status !== 200) {
              ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
              return 1;
            }
            ctx.stdout = `#${data.number} ${data.title}\n`;
            ctx.stdout += `State: ${data.state.toUpperCase()}  |  ${data.head?.ref} -> ${data.base?.ref}\n`;
            ctx.stdout += `Author: ${data.user?.login}  |  Created: ${timeAgo(data.created_at)}\n`;
            if (data.body) ctx.stdout += `\n${data.body}\n`;
            ctx.stdout += `\n${data.html_url}\n`;
            break;
          }

          case 'merge': {
            const num = positional[0];
            if (!num) {
              ctx.stderr = 'usage: gh pr merge <number> [--merge|--squash|--rebase]\n';
              return 1;
            }
            let mergeMethod = 'merge';
            if (flags['squash'] === 'true') mergeMethod = 'squash';
            if (flags['rebase'] === 'true') mergeMethod = 'rebase';
            const { status, data } = await ghApi(token, 'PUT', `/repos/${repo.owner}/${repo.repo}/pulls/${num}/merge`, {
              merge_method: mergeMethod,
            });
            if (status === 200) {
              ctx.stdout = `Merged PR #${num} (${mergeMethod})\n`;
            } else {
              ctx.stderr = `error: merge failed (HTTP ${status}): ${data?.message || ''}\n`;
              return 1;
            }
            break;
          }

          default:
            ctx.stderr = `gh pr: '${prSub}' is not a valid subcommand\n`;
            return 1;
        }
        break;
      }

      case 'issue': {
        const issueSub = ctx.args[1];
        if (!issueSub || issueSub === '--help') {
          ctx.stdout = `usage: gh issue <command> [flags]

Commands:
  list     List issues
  create   Create an issue
  view     View an issue
`;
          return 0;
        }

        if (!token) {
          ctx.stderr = 'error: authentication required. Set GITHUB_TOKEN.\n';
          return 1;
        }

        const { flags, positional } = parseFlags(ctx.args.slice(2), ['state', 'L', 'limit', 'label', 'title', 'body', 'repo', 'R']);
        const repo = getRepoFromFlags(flags) || await detectRepo(ctx);
        if (!repo) {
          ctx.stderr = 'error: could not detect repository. Use --repo owner/repo.\n';
          return 1;
        }

        switch (issueSub) {
          case 'list': {
            const state = flags['state'] || 'open';
            const limit = parseInt(flags['L'] || flags['limit'] || '30', 10);
            let path = `/repos/${repo.owner}/${repo.repo}/issues?state=${state}&per_page=${limit}`;
            if (flags['label']) path += `&labels=${encodeURIComponent(flags['label'])}`;
            const { status, data } = await ghApi(token, 'GET', path);
            if (status !== 200) {
              ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
              return 1;
            }
            // Filter out pull requests (GitHub API includes PRs in /issues)
            const issues = data.filter((i: any) => !i.pull_request);
            if (issues.length === 0) {
              ctx.stdout = 'No issues match your search\n';
              break;
            }
            for (const issue of issues) {
              const num = `#${issue.number}`.padEnd(6);
              const title = issue.title.slice(0, 50).padEnd(50);
              const labels = (issue.labels || []).map((l: any) => l.name).join(',');
              const state = issue.state.toUpperCase().padEnd(8);
              const age = timeAgo(issue.created_at);
              ctx.stdout += `${num}  ${title}  ${labels.padEnd(20)}  ${state}  ${age}\n`;
            }
            break;
          }

          case 'create': {
            const title = flags['title'] || flags['t'];
            const body = flags['body'] || flags['b'] || '';
            if (!title) {
              ctx.stderr = 'error: --title is required\n';
              return 1;
            }
            const { status, data } = await ghApi(token, 'POST', `/repos/${repo.owner}/${repo.repo}/issues`, {
              title, body,
            });
            if (status === 201) {
              ctx.stdout = `Created issue #${data.number}: ${data.title}\n${data.html_url}\n`;
            } else {
              ctx.stderr = `error: failed to create issue (HTTP ${status}): ${data?.message || ''}\n`;
              return 1;
            }
            break;
          }

          case 'view': {
            const num = positional[0];
            if (!num) {
              ctx.stderr = 'usage: gh issue view <number>\n';
              return 1;
            }
            const { status, data } = await ghApi(token, 'GET', `/repos/${repo.owner}/${repo.repo}/issues/${num}`);
            if (status !== 200) {
              ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
              return 1;
            }
            ctx.stdout = `#${data.number} ${data.title}\n`;
            ctx.stdout += `State: ${data.state.toUpperCase()}  |  Author: ${data.user?.login}\n`;
            const labels = (data.labels || []).map((l: any) => l.name).join(', ');
            if (labels) ctx.stdout += `Labels: ${labels}\n`;
            ctx.stdout += `Created: ${timeAgo(data.created_at)}`;
            if (data.closed_at) ctx.stdout += `  |  Closed: ${timeAgo(data.closed_at)}`;
            ctx.stdout += '\n';
            if (data.body) ctx.stdout += `\n${data.body}\n`;
            ctx.stdout += `\n${data.html_url}\n`;
            break;
          }

          default:
            ctx.stderr = `gh issue: '${issueSub}' is not a valid subcommand\n`;
            return 1;
        }
        break;
      }

      case 'api': {
        const { flags, positional } = parseFlags(ctx.args.slice(1), ['X', 'f', 'F', 'H', 'repo', 'R']);
        const path = positional[0];
        if (!path) {
          ctx.stderr = 'usage: gh api <path> [-X METHOD] [-f key=value]\n';
          return 1;
        }
        const method = (flags['X'] || 'GET').toUpperCase();

        // Parse -f key=value fields into body
        let body: Record<string, any> | undefined;
        const fieldArgs = ctx.args.slice(1);
        for (let i = 0; i < fieldArgs.length; i++) {
          if ((fieldArgs[i] === '-f' || fieldArgs[i] === '-F') && fieldArgs[i + 1]) {
            const kv = fieldArgs[++i];
            const eq = kv.indexOf('=');
            if (eq > 0) {
              if (!body) body = {};
              body[kv.slice(0, eq)] = kv.slice(eq + 1);
            }
          }
        }

        // Expand {owner}/{repo} placeholders
        let resolvedPath = path;
        if (resolvedPath.includes('{owner}') || resolvedPath.includes('{repo}')) {
          const repo = getRepoFromFlags(flags) || await detectRepo(ctx);
          if (repo) {
            resolvedPath = resolvedPath.replace('{owner}', repo.owner).replace('{repo}', repo.repo);
          }
        }

        if (!token) {
          ctx.stderr = 'warning: no token set, request may fail for private resources\n';
        }
        const { status, data } = await ghApi(token, method, resolvedPath, body);
        if (status >= 400) {
          ctx.stderr = `error: API returned ${status}\n`;
        }
        ctx.stdout = JSON.stringify(data, null, 2) + '\n';
        return status >= 400 ? 1 : 0;
      }

      default:
        ctx.stderr = `gh: '${sub}' is not a valid command. See 'gh --help'.\n`;
        return 1;
    }

    return 0;
  },
};
