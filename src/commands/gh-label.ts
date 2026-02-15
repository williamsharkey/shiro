import { CommandContext } from './index';
import { ghApi, parseFlags, getRepoFromFlags, detectRepo, isDryRun } from './gh';

const VALUE_FLAGS = ['repo', 'R', 'color', 'description', 'L', 'limit'];

export async function ghLabelHandler(ctx: CommandContext, token: string): Promise<number> {
  const sub = ctx.args[1];
  if (!sub || sub === '--help') {
    ctx.stdout = `usage: gh label <command> [flags]

Commands:
  list     List labels
  create   Create a label <name> [--color HEX] [--description TEXT]
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
      const limit = parseInt(flags['L'] || flags['limit'] || '30', 10);
      const { status, data } = await ghApi(token, 'GET', `${base}/labels?per_page=${limit}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      if (!data || data.length === 0) {
        ctx.stdout = 'No labels found\n';
        return 0;
      }
      for (const l of data) {
        const name = (l.name || '').padEnd(25);
        const color = `#${l.color || '000000'}`;
        const desc = l.description || '';
        ctx.stdout += `${name}  ${color}  ${desc}\n`;
      }
      return 0;
    }

    case 'create': {
      const name = positional[0];
      if (!name) {
        ctx.stderr = 'error: label name is required\nusage: gh label create <name> [--color HEX] [--description TEXT]\n';
        return 1;
      }
      const payload: any = { name };
      if (flags['color']) payload.color = flags['color'].replace(/^#/, '');
      if (flags['description']) payload.description = flags['description'];

      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would POST ${base}/labels\n`;
        ctx.stdout += `  name: ${name}\n`;
        if (payload.color) ctx.stdout += `  color: #${payload.color}\n`;
        if (payload.description) ctx.stdout += `  description: ${payload.description}\n`;
        return 0;
      }

      const { status, data } = await ghApi(token, 'POST', `${base}/labels`, payload);
      if (status === 201) {
        ctx.stdout = `Created label "${data.name}" (#${data.color})\n`;
      } else {
        ctx.stderr = `error: failed to create label (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      return 0;
    }

    default:
      ctx.stderr = `gh label: '${sub}' is not a valid subcommand. Valid: list, create\n`;
      return 1;
  }
}
