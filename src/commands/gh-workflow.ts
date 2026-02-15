import { CommandContext } from './index';
import { ghApi, parseFlags, getRepoFromFlags, detectRepo, timeAgo, isDryRun } from './gh';

const VALUE_FLAGS = ['repo', 'R', 'L', 'limit', 'json'];

export async function ghWorkflowHandler(ctx: CommandContext, token: string): Promise<number> {
  const sub = ctx.args[1];
  if (!sub || sub === '--help') {
    ctx.stdout = `usage: gh workflow <command> [flags]

Commands:
  list     List workflows

Related:
  gh run list    List workflow runs
  gh run view    View a workflow run
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

  if (sub === 'list') {
    const { status, data } = await ghApi(token, 'GET', `${base}/actions/workflows`);
    if (status !== 200) {
      ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
      return 1;
    }
    const workflows = data.workflows || [];
    if (workflows.length === 0) {
      ctx.stdout = 'No workflows found\n';
      return 0;
    }
    for (const w of workflows) {
      const name = (w.name || '').padEnd(30);
      const state = (w.state || '').padEnd(10);
      ctx.stdout += `${name}  ${state}  ${w.path || ''}\n`;
    }
    return 0;
  }

  ctx.stderr = `gh workflow: '${sub}' is not a valid subcommand. Valid: list\n`;
  return 1;
}

export async function ghRunHandler(ctx: CommandContext, token: string): Promise<number> {
  const sub = ctx.args[1];
  if (!sub || sub === '--help') {
    ctx.stdout = `usage: gh run <command> [flags]

Commands:
  list     List workflow runs
  view     View a workflow run <id>
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

  switch (sub) {
    case 'list': {
      const limit = parseInt(flags['L'] || flags['limit'] || '20', 10);
      const { status, data } = await ghApi(token, 'GET', `${base}/actions/runs?per_page=${limit}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      const runs = data.workflow_runs || [];
      if (runs.length === 0) {
        ctx.stdout = 'No runs found\n';
        return 0;
      }
      for (const r of runs) {
        const status = (r.status || '').padEnd(12);
        const conclusion = (r.conclusion || '').padEnd(10);
        const name = (r.name || '').slice(0, 30).padEnd(30);
        const branch = (r.head_branch || '').padEnd(20);
        const age = timeAgo(r.created_at);
        ctx.stdout += `${r.id}  ${status}  ${conclusion}  ${name}  ${branch}  ${age}\n`;
      }
      return 0;
    }

    case 'view': {
      const runId = positional[0];
      if (!runId) {
        ctx.stderr = 'usage: gh run view <run-id>\n';
        return 1;
      }
      const { status, data } = await ghApi(token, 'GET', `${base}/actions/runs/${runId}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      ctx.stdout = `${data.name || 'Run'} #${data.run_number || runId}\n`;
      ctx.stdout += `Status: ${data.status}  Conclusion: ${data.conclusion || 'pending'}\n`;
      ctx.stdout += `Branch: ${data.head_branch}  Event: ${data.event}\n`;
      ctx.stdout += `Started: ${timeAgo(data.created_at)}\n`;
      ctx.stdout += `\n${data.html_url}\n`;
      return 0;
    }

    default:
      ctx.stderr = `gh run: '${sub}' is not a valid subcommand. Valid: list, view\n`;
      return 1;
  }
}
