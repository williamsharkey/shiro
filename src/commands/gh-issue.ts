import { CommandContext } from './index';
import { ghApi, parseFlags, getRepoFromFlags, detectRepo, timeAgo, isDryRun } from './gh';

const VALID_SUBS = 'list, create, view, close, reopen, comment, edit, delete, lock, label';
const VALUE_FLAGS = [
  'state', 'L', 'limit', 'label', 'title', 'body', 'repo', 'R',
  'assignee', 'search', 'milestone', 'json', 't', 'b',
  'add-label', 'remove-label', 'add', 'remove',
];

export async function ghIssueHandler(ctx: CommandContext, token: string): Promise<number> {
  const issueSub = ctx.args[1];
  if (!issueSub || issueSub === '--help') {
    ctx.stdout = `usage: gh issue <command> [flags]

Commands:
  list     List issues [--state open|closed|all] [--assignee] [--search] [--milestone] [--json fields] [--label]
  create   Create an issue --title "..." [--body "..."] [--label] [--dry-run]
  view     View an issue [--json fields]
  close    Close an issue
  reopen   Reopen an issue
  comment  Add a comment --body "..."
  edit     Edit an issue [--title] [--body] [--add-label]
  delete   Delete an issue (admin only)
  lock     Lock an issue
  label    Manage labels --add/--remove
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
    ctx.stderr = 'error: could not detect repository. Use --repo owner/repo.\n';
    return 1;
  }
  const base = `/repos/${repo.owner}/${repo.repo}`;

  switch (issueSub) {
    case 'list': {
      const state = flags['state'] || 'open';
      const limit = parseInt(flags['L'] || flags['limit'] || '30', 10);
      const jsonFields = flags['json'];

      // --search uses the search API
      if (flags['search']) {
        const q = encodeURIComponent(`${flags['search']} repo:${repo.owner}/${repo.repo} is:issue`);
        const { status, data } = await ghApi(token, 'GET', `/search/issues?q=${q}&per_page=${limit}`);
        if (status !== 200) {
          ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
          return 1;
        }
        const items = (data.items || []).filter((i: any) => !i.pull_request);
        if (items.length === 0) {
          ctx.stdout = 'No issues match your search\n';
          return 0;
        }
        if (jsonFields) return outputJson(ctx, items, jsonFields);
        return formatIssueList(ctx, items);
      }

      let path = `${base}/issues?state=${state}&per_page=${limit}`;
      if (flags['label']) path += `&labels=${encodeURIComponent(flags['label'])}`;
      if (flags['assignee']) path += `&assignee=${encodeURIComponent(flags['assignee'])}`;
      if (flags['milestone']) path += `&milestone=${encodeURIComponent(flags['milestone'])}`;

      const { status, data } = await ghApi(token, 'GET', path);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      const issues = data.filter((i: any) => !i.pull_request);
      if (issues.length === 0) {
        ctx.stdout = 'No issues match your search\n';
        return 0;
      }
      if (jsonFields) return outputJson(ctx, issues, jsonFields);
      return formatIssueList(ctx, issues);
    }

    case 'create': {
      const title = flags['title'] || flags['t'];
      const body = flags['body'] || flags['b'] || '';
      if (!title) {
        ctx.stderr = 'error: --title is required\n';
        return 1;
      }
      const payload: any = { title, body };
      if (flags['label']) payload.labels = flags['label'].split(',');

      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would POST ${base}/issues\n`;
        ctx.stdout += `  title: ${JSON.stringify(title)}\n`;
        if (body) ctx.stdout += `  body: ${JSON.stringify(body)}\n`;
        if (payload.labels) ctx.stdout += `  labels: ${payload.labels.join(', ')}\n`;
        return 0;
      }

      const { status, data } = await ghApi(token, 'POST', `${base}/issues`, payload);
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
        ctx.stderr = 'usage: gh issue view <number> [--json fields]\n';
        return 1;
      }
      const { status, data } = await ghApi(token, 'GET', `${base}/issues/${num}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      if (flags['json']) return outputJson(ctx, data, flags['json']);
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

    case 'close': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh issue close <number>\n'; return 1; }
      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would close issue #${num}\n`;
        return 0;
      }
      const { status, data } = await ghApi(token, 'PATCH', `${base}/issues/${num}`, { state: 'closed' });
      if (status === 200) {
        ctx.stdout = `Closed issue #${num}\n`;
      } else {
        ctx.stderr = `error: failed to close issue (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      break;
    }

    case 'reopen': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh issue reopen <number>\n'; return 1; }
      const { status, data } = await ghApi(token, 'PATCH', `${base}/issues/${num}`, { state: 'open' });
      if (status === 200) {
        ctx.stdout = `Reopened issue #${num}\n`;
      } else {
        ctx.stderr = `error: failed to reopen issue (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      break;
    }

    case 'comment': {
      const num = positional[0];
      const body = flags['body'] || flags['b'];
      if (!num || !body) {
        ctx.stderr = 'usage: gh issue comment <number> --body "..."\n';
        return 1;
      }
      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would comment on issue #${num}\n  body: ${JSON.stringify(body)}\n`;
        return 0;
      }
      const { status, data } = await ghApi(token, 'POST', `${base}/issues/${num}/comments`, { body });
      if (status === 201) {
        ctx.stdout = `Added comment to issue #${num}\n${data.html_url}\n`;
      } else {
        ctx.stderr = `error: failed to comment (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      break;
    }

    case 'edit': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh issue edit <number> [--title "..."] [--body "..."] [--add-label label]\n'; return 1; }
      const payload: any = {};
      if (flags['title'] || flags['t']) payload.title = flags['title'] || flags['t'];
      if (flags['body'] || flags['b']) payload.body = flags['body'] || flags['b'];
      if (flags['add-label']) payload.labels = flags['add-label'].split(',');
      if (Object.keys(payload).length === 0) {
        ctx.stderr = 'error: specify --title, --body, or --add-label\n';
        return 1;
      }
      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would edit issue #${num}\n`;
        for (const [k, v] of Object.entries(payload)) ctx.stdout += `  ${k}: ${JSON.stringify(v)}\n`;
        return 0;
      }
      const { status, data } = await ghApi(token, 'PATCH', `${base}/issues/${num}`, payload);
      if (status === 200) {
        ctx.stdout = `Updated issue #${num}\n`;
      } else {
        ctx.stderr = `error: failed to edit issue (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      break;
    }

    case 'delete': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh issue delete <number> (admin only)\n'; return 1; }
      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would delete issue #${num}\n`;
        return 0;
      }
      const { status, data } = await ghApi(token, 'DELETE', `${base}/issues/${num}`);
      if (status === 204 || status === 200) {
        ctx.stdout = `Deleted issue #${num}\n`;
      } else {
        ctx.stderr = `error: failed to delete issue (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      break;
    }

    case 'lock': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh issue lock <number>\n'; return 1; }
      const { status, data } = await ghApi(token, 'PUT', `${base}/issues/${num}/lock`, {});
      if (status === 204 || status === 200) {
        ctx.stdout = `Locked issue #${num}\n`;
      } else {
        ctx.stderr = `error: failed to lock issue (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      break;
    }

    case 'label': {
      const num = positional[0];
      if (!num) { ctx.stderr = 'usage: gh issue label <number> --add label1,label2 | --remove label\n'; return 1; }
      const addLabels = flags['add'];
      const removeLabel = flags['remove'];
      if (addLabels) {
        const labels = addLabels.split(',').map(l => l.trim());
        const { status, data } = await ghApi(token, 'POST', `${base}/issues/${num}/labels`, { labels });
        if (status === 200) {
          ctx.stdout = `Added labels to issue #${num}: ${labels.join(', ')}\n`;
        } else {
          ctx.stderr = `error: failed to add labels (HTTP ${status}): ${data?.message || ''}\n`;
          return 1;
        }
      } else if (removeLabel) {
        const { status, data } = await ghApi(token, 'DELETE', `${base}/issues/${num}/labels/${encodeURIComponent(removeLabel)}`);
        if (status === 200 || status === 204) {
          ctx.stdout = `Removed label '${removeLabel}' from issue #${num}\n`;
        } else {
          ctx.stderr = `error: failed to remove label (HTTP ${status}): ${data?.message || ''}\n`;
          return 1;
        }
      } else {
        ctx.stderr = 'usage: gh issue label <number> --add label1,label2 | --remove label\n';
        return 1;
      }
      break;
    }

    default:
      ctx.stderr = `gh issue: '${issueSub}' is not a valid subcommand. Valid: ${VALID_SUBS}\n`;
      return 1;
  }

  return 0;
}

function formatIssueList(ctx: CommandContext, issues: any[]): number {
  for (const issue of issues) {
    const num = `#${issue.number}`.padEnd(6);
    const title = issue.title.slice(0, 50).padEnd(50);
    const labels = (issue.labels || []).map((l: any) => l.name).join(',');
    const state = issue.state.toUpperCase().padEnd(8);
    const age = timeAgo(issue.created_at);
    ctx.stdout += `${num}  ${title}  ${labels.padEnd(20)}  ${state}  ${age}\n`;
  }
  return 0;
}

function outputJson(ctx: CommandContext, data: any, fields: string): number {
  const fieldList = fields.split(',').map(f => f.trim());
  if (Array.isArray(data)) {
    const filtered = data.map(item => pickFields(item, fieldList));
    ctx.stdout = JSON.stringify(filtered, null, 2) + '\n';
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
