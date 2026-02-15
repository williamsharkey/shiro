import git from 'isomorphic-git';
import { CommandContext } from './index';
import { ghApi, parseFlags, getRepoFromFlags, detectRepo, timeAgo, isDryRun } from './gh';

const VALID_SUBS = 'list, create, view, merge, close, reopen, comment, diff, checks, review, edit, ready';
const VALUE_FLAGS = [
  'state', 'L', 'limit', 'title', 'body', 'base', 'head', 'repo', 'R',
  'json', 't', 'b', 'add-label', 'remove-label', 'label', 'reviewer', 'assignee',
];

export async function ghPrHandler(ctx: CommandContext, token: string): Promise<number> {
  const prSub = ctx.args[1];
  if (!prSub || prSub === '--help') {
    ctx.stdout = `usage: gh pr <command> [flags]

Commands:
  list     List pull requests [--state open|closed|all] [--json fields]
  create   Create a pull request --title "..." [--body] [--base] [--head] [--dry-run]
  view     View a pull request [--json fields]
  merge    Merge a pull request [--merge|--squash|--rebase] [--dry-run]
  close    Close a pull request
  reopen   Reopen a pull request
  comment  Add a comment --body "..."
  diff     Show pull request diff
  checks   Show CI check status
  review   Submit a review [--approve|--comment|--request-changes] [--body]
  edit     Edit a pull request [--title] [--body] [--base]
  ready    Mark as ready for review
`;
    return 0;
  }

  if (!token) {
    ctx.stderr = 'error: authentication required. Set GITHUB_TOKEN.\n';
    return 1;
  }

  const { flags, positional } = parseFlags(ctx.args.slice(2), VALUE_FLAGS);
  const repo = getRepoFromFlags(flags) || await detectRepo(ctx);
  if (!repo) {
    ctx.stderr = 'error: could not detect repository. Use --repo owner/repo or run from a git repo with a GitHub remote.\n';
    return 1;
  }
  const base = `/repos/${repo.owner}/${repo.repo}`;

  switch (prSub) {
    case 'list': {
      const state = flags['state'] || 'open';
      const limit = parseInt(flags['L'] || flags['limit'] || '30', 10);
      const { status, data } = await ghApi(token, 'GET', `${base}/pulls?state=${state}&per_page=${limit}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      if (!data || data.length === 0) {
        ctx.stdout = 'No pull requests match your search\n';
        return 0;
      }
      if (flags['json']) return outputJson(ctx, data, flags['json']);
      for (const pr of data) {
        const num = `#${pr.number}`.padEnd(6);
        const title = pr.title.slice(0, 50).padEnd(50);
        const branch = `${pr.head?.ref || '?'} -> ${pr.base?.ref || '?'}`;
        const st = pr.state.toUpperCase().padEnd(8);
        const age = timeAgo(pr.created_at);
        ctx.stdout += `${num}  ${title}  ${branch.padEnd(30)}  ${st}  ${age}\n`;
      }
      return 0;
    }

    case 'create': {
      const title = flags['title'] || flags['t'];
      const body = flags['body'] || flags['b'] || '';
      const baseBranch = flags['base'] || 'main';
      let head = flags['head'] || '';
      const draft = flags['draft'] === 'true';
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
      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would POST ${base}/pulls\n`;
        ctx.stdout += `  title: ${JSON.stringify(title)}\n`;
        ctx.stdout += `  head: ${head} -> base: ${baseBranch}\n`;
        if (body) ctx.stdout += `  body: ${JSON.stringify(body)}\n`;
        if (draft) ctx.stdout += `  draft: true\n`;
        if (flags['label']) ctx.stdout += `  labels: ${flags['label']}\n`;
        if (flags['reviewer']) ctx.stdout += `  reviewers: ${flags['reviewer']}\n`;
        if (flags['assignee']) ctx.stdout += `  assignees: ${flags['assignee']}\n`;
        return 0;
      }
      const createPayload: any = { title, body, head, base: baseBranch };
      if (draft) createPayload.draft = true;
      const { status, data } = await ghApi(token, 'POST', `${base}/pulls`, createPayload);
      if (status === 201) {
        ctx.stdout = `Created PR #${data.number}: ${data.title}\n${data.html_url}\n`;
        // Add labels after creation
        if (flags['label']) {
          const labels = flags['label'].split(',').map((l: string) => l.trim());
          await ghApi(token, 'POST', `${base}/issues/${data.number}/labels`, { labels });
        }
        // Request reviewers
        if (flags['reviewer']) {
          const reviewers = flags['reviewer'].split(',').map((r: string) => r.trim());
          await ghApi(token, 'POST', `${base}/pulls/${data.number}/requested_reviewers`, { reviewers });
        }
        // Add assignees
        if (flags['assignee']) {
          const assignees = flags['assignee'].split(',').map((a: string) => a.trim());
          await ghApi(token, 'POST', `${base}/issues/${data.number}/assignees`, { assignees });
        }
      } else {
        ctx.stderr = `error: failed to create PR (HTTP ${status}): ${data?.message || JSON.stringify(data?.errors)}\n`;
        return 1;
      }
      return 0;
    }

    case 'view': {
      const num = positional[0];
      if (!num) {
        ctx.stderr = 'usage: gh pr view <number> [--json fields]\n';
        return 1;
      }
      const { status, data } = await ghApi(token, 'GET', `${base}/pulls/${num}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      if (flags['json']) return outputJson(ctx, data, flags['json']);
      ctx.stdout = `#${data.number} ${data.title}\n`;
      ctx.stdout += `State: ${data.state.toUpperCase()}  |  ${data.head?.ref} -> ${data.base?.ref}\n`;
      ctx.stdout += `Author: ${data.user?.login}  |  Created: ${timeAgo(data.created_at)}\n`;
      if (data.body) ctx.stdout += `\n${data.body}\n`;
      ctx.stdout += `\n${data.html_url}\n`;
      return 0;
    }

    case 'merge': {
      const num = positional[0];
      if (!num) {
        ctx.stderr = 'usage: gh pr merge <number> [--merge|--squash|--rebase] [--delete-branch] [--auto] [--body MSG] [--dry-run]\n';
        return 1;
      }
      let mergeMethod = 'merge';
      if (flags['squash'] === 'true') mergeMethod = 'squash';
      if (flags['rebase'] === 'true') mergeMethod = 'rebase';
      const deleteBranch = flags['delete-branch'] === 'true' || flags['d'] === 'true';
      const autoMerge = flags['auto'] === 'true';
      const commitBody = flags['body'] || flags['b'] || '';
      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would merge PR #${num} (${mergeMethod})\n`;
        if (autoMerge) ctx.stdout += `[dry-run] Would enable auto-merge\n`;
        if (commitBody) ctx.stdout += `[dry-run] Commit message: ${commitBody}\n`;
        if (deleteBranch) ctx.stdout += `[dry-run] Would delete head branch\n`;
        return 0;
      }
      const mergePayload: any = { merge_method: mergeMethod };
      if (commitBody) mergePayload.commit_message = commitBody;
      if (autoMerge) mergePayload.auto_merge = true;
      const { status, data } = await ghApi(token, 'PUT', `${base}/pulls/${num}/merge`, mergePayload);
      if (status === 200) {
        ctx.stdout = `Merged PR #${num} (${mergeMethod})\n`;
        if (deleteBranch) {
          // Get the PR to find head branch
          const { data: prData } = await ghApi(token, 'GET', `${base}/pulls/${num}`);
          const headBranch = prData?.head?.ref;
          if (headBranch) {
            const { status: delStatus } = await ghApi(token, 'DELETE', `${base}/git/refs/heads/${headBranch}`);
            if (delStatus === 204) {
              ctx.stdout += `Deleted branch ${headBranch}\n`;
            }
          }
        }
      } else {
        ctx.stderr = `error: merge failed (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      return 0;
    }

    case 'close': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh pr close <number>\n'; return 1; }
      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would close PR #${num}\n`;
        return 0;
      }
      const { status, data } = await ghApi(token, 'PATCH', `${base}/pulls/${num}`, { state: 'closed' });
      if (status === 200) {
        ctx.stdout = `Closed PR #${num}\n`;
      } else {
        ctx.stderr = `error: failed to close PR (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      return 0;
    }

    case 'reopen': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh pr reopen <number>\n'; return 1; }
      const { status, data } = await ghApi(token, 'PATCH', `${base}/pulls/${num}`, { state: 'open' });
      if (status === 200) {
        ctx.stdout = `Reopened PR #${num}\n`;
      } else {
        ctx.stderr = `error: failed to reopen PR (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      return 0;
    }

    case 'comment': {
      const num = positional[0];
      const body = flags['body'] || flags['b'];
      if (!num || !body) {
        ctx.stderr = 'usage: gh pr comment <number> --body "..."\n';
        return 1;
      }
      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would comment on PR #${num}\n  body: ${JSON.stringify(body)}\n`;
        return 0;
      }
      // PRs use the issues endpoint for comments
      const { status, data } = await ghApi(token, 'POST', `${base}/issues/${num}/comments`, { body });
      if (status === 201) {
        ctx.stdout = `Added comment to PR #${num}\n${data.html_url}\n`;
      } else {
        ctx.stderr = `error: failed to comment (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      return 0;
    }

    case 'diff': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh pr diff <number>\n'; return 1; }
      const { status, data } = await ghApi(token, 'GET', `${base}/pulls/${num}`, undefined, {
        'Accept': 'application/vnd.github.diff',
      });
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      // When Accept is diff, data may come back as text via json parse fail (null) — re-fetch as text
      if (data === null) {
        const baseUrl = typeof location !== 'undefined' ? location.origin + '/api/github' : 'https://api.github.com';
        const url = `${baseUrl}${base}/pulls/${num}`;
        const resp = await fetch(url, {
          headers: {
            'Accept': 'application/vnd.github.diff',
            'Authorization': `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        ctx.stdout = await resp.text();
      } else {
        ctx.stdout = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
      }
      return 0;
    }

    case 'checks': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh pr checks <number>\n'; return 1; }
      // First get the PR to find head SHA
      const { status: prStatus, data: prData } = await ghApi(token, 'GET', `${base}/pulls/${num}`);
      if (prStatus !== 200) {
        ctx.stderr = `error: API returned ${prStatus}: ${prData?.message || ''}\n`;
        return 1;
      }
      const sha = prData.head?.sha;
      if (!sha) {
        ctx.stderr = 'error: could not determine head commit SHA\n';
        return 1;
      }
      const { status, data } = await ghApi(token, 'GET', `${base}/commits/${sha}/check-runs`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      const runs = data.check_runs || [];
      if (runs.length === 0) {
        ctx.stdout = 'No checks found\n';
        return 0;
      }
      for (const run of runs) {
        const icon = run.conclusion === 'success' ? 'pass' : run.conclusion === 'failure' ? 'fail' : run.status;
        const name = run.name.padEnd(40);
        ctx.stdout += `${icon.padEnd(10)}  ${name}  ${run.conclusion || run.status}\n`;
      }
      return 0;
    }

    case 'review': {
      const num = positional[0];
      if (!num) {
        ctx.stderr = 'usage: gh pr review <number> [--approve|--comment|--request-changes] [--body "..."]\n';
        return 1;
      }
      let event = 'COMMENT';
      if (flags['approve'] === 'true') event = 'APPROVE';
      if (flags['request-changes'] === 'true') event = 'REQUEST_CHANGES';
      const body = flags['body'] || flags['b'] || '';
      if (event === 'REQUEST_CHANGES' && !body) {
        ctx.stderr = 'error: --body is required when requesting changes\n';
        return 1;
      }
      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would submit ${event} review on PR #${num}\n`;
        if (body) ctx.stdout += `  body: ${JSON.stringify(body)}\n`;
        return 0;
      }
      const { status, data } = await ghApi(token, 'POST', `${base}/pulls/${num}/reviews`, {
        event,
        body,
      });
      if (status === 200) {
        ctx.stdout = `Submitted ${event.toLowerCase()} review on PR #${num}\n`;
      } else {
        ctx.stderr = `error: failed to submit review (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      return 0;
    }

    case 'edit': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh pr edit <number> [--title "..."] [--body "..."] [--base branch]\n'; return 1; }
      const payload: any = {};
      if (flags['title'] || flags['t']) payload.title = flags['title'] || flags['t'];
      if (flags['body'] || flags['b']) payload.body = flags['body'] || flags['b'];
      if (flags['base']) payload.base = flags['base'];
      if (Object.keys(payload).length === 0) {
        ctx.stderr = 'error: specify --title, --body, or --base\n';
        return 1;
      }
      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would edit PR #${num}\n`;
        for (const [k, v] of Object.entries(payload)) ctx.stdout += `  ${k}: ${JSON.stringify(v)}\n`;
        return 0;
      }
      const { status, data } = await ghApi(token, 'PATCH', `${base}/pulls/${num}`, payload);
      if (status === 200) {
        ctx.stdout = `Updated PR #${num}\n`;
      } else {
        ctx.stderr = `error: failed to edit PR (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      return 0;
    }

    case 'ready': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh pr ready <number>\n'; return 1; }
      const { status, data } = await ghApi(token, 'PUT', `${base}/pulls/${num}`, { draft: false });
      if (status === 200) {
        ctx.stdout = `PR #${num} marked as ready for review\n`;
      } else {
        ctx.stderr = `error: failed to mark as ready (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      return 0;
    }

    default:
      ctx.stderr = `gh pr: '${prSub}' is not a valid subcommand. Valid: ${VALID_SUBS}\n`;
      return 1;
  }
}

function outputJson(ctx: CommandContext, data: any, fields: string): number {
  const fieldList = fields.split(',').map(f => f.trim());
  if (Array.isArray(data)) {
    ctx.stdout = JSON.stringify(data.map(item => pickFields(item, fieldList)), null, 2) + '\n';
  } else {
    ctx.stdout = JSON.stringify(pickFields(data, fieldList), null, 2) + '\n';
  }
  return 0;
}

function pickFields(obj: any, fields: string[]): any {
  const result: any = {};
  for (const f of fields) {
    if (f in obj) result[f] = obj[f];
  }
  return result;
}
